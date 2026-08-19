import {describe, it, expect} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * 純靜態檢查：只讀原始碼的文字，不 import 任何模組。
 *
 * 這很重要 —— 測試環境(FreeBSD jail)只要有測試檔直接或間接 import 到
 * discord.js 就會卡住跑不完，所以凡是需要碰 src/ 實際行為的檢查都做不了。
 * 但「檔案長什麼樣」這種問題用讀字串就能回答，不受那個限制。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const listFiles = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if(entry.isDirectory()) return listFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
})

const sourceFiles = listFiles(path.join(ROOT, 'src'))
const testFiles = listFiles(path.join(ROOT, 'tests'))

const read = (file) => fs.readFileSync(file, 'utf8')
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')

describe('export default 必須放在所有宣告之後', () => {
    /**
     * 2026-08-18 的實際事故：export default 的物件在模組載入當下就求值，
     * 擺在 const 宣告之前的話那些 const 還在 TDZ，直接
     * ReferenceError: Cannot access 'x' before initialization。
     *
     * 爆點在 loader 載入指令與事件的當下 —— bot 看起來有上線，
     * 但整組斜線指令都註冊不上，從畫面上完全看不出原因。
     * 同一個坑我踩過兩次，所以釘起來。
     */
    it.each(sourceFiles.filter((file) => read(file).includes('\nexport default {')))(
        '%s',
        (file) => {
            const lines = read(file).split('\n')
            const defaultAt = lines.findIndex((line) => line.startsWith('export default {'))
            const lastDeclaration = lines.reduce(
                (last, line, index) => (/^export (const|function|class) /.test(line) ? index : last),
                -1,
            )

            expect(
                defaultAt,
                `${relative(file)}：export default 在第 ${defaultAt + 1} 行，` +
                `但還有宣告在第 ${lastDeclaration + 1} 行，載入時會 TDZ 報錯`,
            ).toBeGreaterThan(lastDeclaration)
        },
    )
})

describe('測試檔不得碰到 discord.js', () => {
    /**
     * 測試 jail 裡只要測試檔直接或間接 import 到 discord.js 就會卡住跑不完。
     * 這條規則是靠實驗歸納出來的：卡住的檔案全部有碰，跑得完的全部沒碰。
     * 介面的正確性改用測試伺服器實機驗收，詳見 docs/PLAN.md。
     */
    const FORBIDDEN = [
        'discord.js',
        '@/core/pollService',
        '@/core/pollRender',
        '@/core/pollAdmin',
        '@/core/pollTemplateAdmin',
        '@/core/rolePanel',
    ]

    it.each(testFiles.filter((file) => !file.endsWith('moduleLayout.test.js')))(
        '%s',
        (file) => {
            const content = read(file)
            const found = FORBIDDEN.filter((name) => content.includes(`'${name}'`))
            expect(found, `${relative(file)} 匯入了 ${found.join('、')}`).toEqual([])
        },
    )
})

describe('原始碼的引號與括號必須平衡', () => {
    /**
     * 2026-08-18 發生兩次：用腳本改檔時字串裡的換行轉義被多吃一層，
     * 變成真正的換行，字串沒有結束 —— 整個檔案語法錯誤。
     *
     * vite 只會說「某個檔案含有無效的 JS 語法」而**不說是哪一支**，
     * 而且 bot 會照常上線、只是指令表建不起來，畫面上看不出原因。
     * 這個掃描直接指出檔名與行號。
     *
     * 它不是完整的 parser，只認引號、樣板字串、註解與三種括號 ——
     * 但實際踩到的兩次都屬於這一類。
     */
    const OPEN = {')': '(', ']': '[', '}': '{'}

    const scan = (source) => {
        const depth = {'(': 0, '[': 0, '{': 0}
        const issues = []
        let line = 1
        let mode = null      //null / line / block / str / tmpl
        let quote = null

        for(let i = 0; i < source.length; i += 1){
            const c = source[i]
            if(c === '\n') line += 1

            if(mode === 'line'){
                if(c === '\n') mode = null
            }
            else if(mode === 'block'){
                if(c === '*' && source[i + 1] === '/'){ mode = null; i += 1 }
            }
            else if(mode === 'str'){
                if(c === '\\') i += 1
                else if(c === quote) mode = null
                else if(c === '\n'){ issues.push(`第 ${line} 行：字串沒有結束`); mode = null }
            }
            else if(mode === 'tmpl'){
                if(c === '\\') i += 1
                else if(c === '`') mode = null
            }
            else if(c === '/' && source[i + 1] === '/'){ mode = 'line'; i += 1 }
            else if(c === '/' && source[i + 1] === '*'){ mode = 'block'; i += 1 }
            else if(c === '"' || c === "'"){ mode = 'str'; quote = c }
            else if(c === '`') mode = 'tmpl'
            else if(c === '(' || c === '[' || c === '{') depth[c] += 1
            else if(c === ')' || c === ']' || c === '}'){
                depth[OPEN[c]] -= 1
                if(depth[OPEN[c]] < 0) issues.push(`第 ${line} 行：多餘的 ${c}`)
            }
        }

        for(const [bracket, count] of Object.entries(depth)){
            if(count !== 0) issues.push(`${bracket} 沒有配對完：${count > 0 ? '缺少' : '多出'} ${Math.abs(count)} 個`)
        }
        if(mode === 'str' || mode === 'tmpl') issues.push('檔案結束時字串還沒結束')

        return issues
    }

    it.each([...sourceFiles, ...testFiles])('%s', (file) => {
        expect(scan(read(file)), relative(file)).toEqual([])
    })
})
