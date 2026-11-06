import logger from '@/core/logger'

//Gemini 的薄包裝(U14)。只負責「送一段提示詞、拿回一段文字」，不認識任何業務。
//
//用原生 fetch 打 REST API，不裝 SDK：只用到 generateContent 一個端點，
//為它多一個相依不划算(單元檔 U14 的決策紀錄)。
//
//這支檔案絕不往外拋錯：摘要是附加價值，失敗了呼叫端要能退回貼原文，
//而不是整篇文章跟著失敗。所有失敗都回 {text: null, reason}。

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

//HTTP 狀態碼 → 換下一個模型(next)或直接放棄(abort)。
//- 503 high demand、429 額度用完：換一個模型通常就過了(2026-11-04 實測 3.8-flash 回 503、3.5-flash 正常)
//- 404：模型被汰換(實測 2.5-flash 對新帳號回 404)
//- 401/403/400：key 本身有問題(無效的 key 回的是 400)，換模型也一樣，不必浪費時間
export const classifyStatus = (status) => {
    if(status === 404 || status === 429 || status >= 500) return 'next'
    return 'abort'
}

//從 generateContent 的回應取出文字。
//parts 裡除了 text 還會有 thoughtSignature(思考簽章)；thought: true 的片段是思考過程，
//兩者都不能貼出去。沒有 candidates(例如被安全過濾擋下)或格式不對 → null。
export const extractText = (json) => {
    try{
        const parts = json?.candidates?.[0]?.content?.parts
        if(!Array.isArray(parts)) return null
        const text = parts
            .filter((part) => part && typeof part.text === 'string' && !part.thought)
            .map((part) => part.text)
            .join('')
            .trim()
        return text || null
    }
    catch{
        return null
    }
}

export const buildRequestBody = (prompt) => ({
    contents: [{parts: [{text: String(prompt)}]}],
})

//依序嘗試 models，第一個成功的就回。
//回傳 {text, model}；失敗時 {text: null, model: null, reason}。
//label 只用在 log 上，讓一次檢查裡兩種語言的嘗試分得出來。
export const generateText = async(prompt, {models = [], timeoutMs = 90000, apiKey = process.env.GEMINI_API_KEY, label = 'Gemini'} = {}) => {
    if(!apiKey){
        logger.warn(`${label}：沒有設定 GEMINI_API_KEY，跳過`)
        return {text: null, model: null, reason: 'no-key'}
    }

    //金鑰會直接塞進 HTTP header，而 header 只容得下 Latin-1(0-255)。
    //含非 ASCII 字元時 undici 會丟
    //「Cannot convert argument to a ByteString because the character at index N
    //  has a value of 65533 which is greater than 255」——
    //65533 是 U+FFFD(�)，代表 .env 那一行的 bytes 不是合法的 UTF-8，
    //多半是用 PowerShell 的 >> 或 Add-Content 附加時寫成 UTF-16／ANSI。
    //
    //在這裡先擋下來並講清楚，不然那串訊息會對每個模型、每種語言各噴一次，
    //而且看的人完全不會聯想到是檔案編碼的問題。
    const badAt = [...String(apiKey)].findIndex((ch) => ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 32)
    if(badAt >= 0){
        logger.error(
            `${label}：GEMINI_API_KEY 第 ${badAt + 1} 個字元不是可列印的 ASCII` +
            `(U+${String(apiKey).charCodeAt(badAt).toString(16).toUpperCase().padStart(4, '0')})，` +
            '這是 .env 的編碼問題不是金鑰本身。請在 jail 裡用 vi 重打那一行，存成純 ASCII／UTF-8。'
        )
        return {text: null, model: null, reason: 'bad-key'}
    }

    //⚠️ 429 跟 503 都會換下一個模型，但意義完全不同：
    //  503 是當下的尖峰，等幾十秒就過了
    //  429 是這把金鑰的額度用完，等再久也一樣，要等到重置(免費層是每天)
    //不分開的話，呼叫端會用短間隔一直重試，把剩下的額度燒得更快 ——
    //2026-11-06 正式站就是這樣，兩輪重試共 16 次呼叫，把本來還能用的額度打完(U14)。
    let quota = false

    for(const model of models){
        try{
            const res = await fetch(`${API_BASE}/${model}:generateContent`, {
                method: 'POST',
                headers: {'x-goog-api-key': apiKey, 'Content-Type': 'application/json'},
                body: JSON.stringify(buildRequestBody(prompt)),
                signal: AbortSignal.timeout(timeoutMs),
            })

            if(res.ok){
                const text = extractText(await res.json().catch(() => null))
                if(text){
                    logger.info(`${label}：${model} 成功，${text.length} 字`)
                    return {text, model}
                }
                //200 卻沒有文字，多半是被安全過濾擋下；換一個模型再試
                logger.warn(`${label}：${model} 回 200 但沒有可用的文字，換下一個模型`)
                continue
            }

            if(res.status === 429) quota = true

            const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
            const decision = classifyStatus(res.status)
            logger.warn(
                `${label}：${model} HTTP ${res.status}，` +
                `${decision === 'next' ? '換下一個模型' : '不再嘗試其他模型'}：${detail}`
            )
            if(decision === 'abort') return {text: null, model: null, reason: `http-${res.status}`, quota}
        }
        catch(e){
            const why = e && e.name === 'TimeoutError' ? `逾時 ${timeoutMs}ms` : (e && e.message) || String(e)
            logger.warn(`${label}：${model} 呼叫失敗(${why})，換下一個模型`)
        }
    }

    logger.warn(
        `${label}：所有模型都失敗(${models.join(' → ') || '清單是空的'})` +
        (quota ? '，其中有模型回 429 額度用完，短時間內重試沒有意義' : '')
    )
    return {text: null, model: null, reason: 'all-failed', quota}
}

export default {
    classifyStatus,
    extractText,
    buildRequestBody,
    generateText,
}
