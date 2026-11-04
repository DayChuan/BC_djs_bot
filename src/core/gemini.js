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

            const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
            const decision = classifyStatus(res.status)
            logger.warn(
                `${label}：${model} HTTP ${res.status}，` +
                `${decision === 'next' ? '換下一個模型' : '不再嘗試其他模型'}：${detail}`
            )
            if(decision === 'abort') return {text: null, model: null, reason: `http-${res.status}`}
        }
        catch(e){
            const why = e && e.name === 'TimeoutError' ? `逾時 ${timeoutMs}ms` : (e && e.message) || String(e)
            logger.warn(`${label}：${model} 呼叫失敗(${why})，換下一個模型`)
        }
    }

    logger.warn(`${label}：所有模型都失敗(${models.join(' → ') || '清單是空的'})`)
    return {text: null, model: null, reason: 'all-failed'}
}

export default {
    classifyStatus,
    extractText,
    buildRequestBody,
    generateText,
}
