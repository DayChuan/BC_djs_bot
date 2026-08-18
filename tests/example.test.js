/**
 * 測試範本 —— 照著這支改就能寫出自己的測試。
 *
 * 這支本身是會通過的真測試，不是只有註解的假檔案；
 * 跑 `yarn test` 時它會跟其他測試一起執行，所以改壞了會立刻知道。
 *
 * 檔名規則：放在 tests/ 底下、以 .test.js 結尾，vitest 就會自動掃到，
 * 不需要去任何設定檔登記。
 *
 * 只跑這一支：      yarn test tests/example.test.js
 * 只跑一個案例：    yarn test -t "兩數相加"
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'

//被測對象通常是從 src/ import 進來的，例如：
//import {parseOptionsInput} from '@/core/pollStore'
//這裡為了讓範本自成一體，直接在檔案內定義幾個假的被測函式。

const add = (a, b) => a + b

const divide = (a, b) => {
    if(b === 0) throw new Error('不能除以零')
    return a / b
}

const makeCounter = () => {
    let count = 0
    return {
        increase: () => {
            count += 1
            return count
        },
        value: () => count,
    }
}

/////////////////////////////// 1. 最基本的形狀 ///////////////////////////////

//describe = 分類。只是把相關的案例框在一起，失敗訊息會顯示這個名字。
describe('add', () => {
    //it = 一個案例。名字寫「應該發生什麼」，因為失敗時你看到的就是這行字。
    it('兩數相加', () => {
        //三段式：安排 → 執行 → 斷言
        const a = 2                    //安排：準備輸入
        const b = 3
        const result = add(a, b)       //執行：呼叫被測對象
        expect(result).toBe(5)         //斷言：檢查結果
    })

    //簡單到一行講得完的，就不用硬拆三段
    it('負數也對', () => {
        expect(add(-1, -2)).toBe(-3)
    })
})

/////////////////////////////// 2. 常用的斷言 ///////////////////////////////

describe('常用斷言', () => {
    it('toBe 比基本型別(字串、數字、布林)', () => {
        expect('紅').toBe('紅')
        expect(1 + 1).toBe(2)
    })

    it('toEqual 比物件與陣列的「內容」', () => {
        //注意：這裡不能用 toBe。兩個長得一樣的物件不是同一個實體，
        //toBe 會失敗，這是最常見的坑。
        expect({key: 'o0', label: '紅'}).toEqual({key: 'o0', label: '紅'})
        expect([1, 2, 3]).toEqual([1, 2, 3])
    })

    it('toHaveLength 比長度', () => {
        expect([1, 2, 3]).toHaveLength(3)
    })

    it('toContain 檢查「包含」', () => {
        expect('已登記：星期二').toContain('星期二')     //字串包含子字串
        expect(['紅', '藍']).toContain('藍')            //陣列包含某個元素
    })

    it('toBeNull / toBeUndefined 檢查空值', () => {
        expect(null).toBeNull()
        expect(undefined).toBeUndefined()
    })

    it('toThrow 檢查「應該要拋錯」', () => {
        //注意要包一層箭頭函式，直接寫 divide(1, 0) 的話錯誤會在
        //進到 expect 之前就炸出來，測試會變成失敗而不是通過。
        expect(() => divide(1, 0)).toThrow()
        expect(() => divide(1, 0)).toThrow('不能除以零')   //也可以檢查訊息
        expect(divide(6, 2)).toBe(3)                      //不該拋錯的情況
    })

    it('not 可以反過來用', () => {
        expect(add(1, 1)).not.toBe(3)
    })
})

/////////////////////////// 3. 每個案例前後的準備與清理 ///////////////////////////

describe('beforeEach / afterEach', () => {
    let counter = null

    //每個 it 之前都會跑一次。用來把狀態重置成乾淨的起點。
    //案例之間互相污染是最難查的測試問題 —— 單獨跑會過、一起跑就掛。
    beforeEach(() => {
        counter = makeCounter()
    })

    //每個 it 之後都會跑一次。用來收尾(刪暫存檔、關計時器之類的)。
    afterEach(() => {
        counter = null
    })

    it('第一次加完是 1', () => {
        expect(counter.increase()).toBe(1)
    })

    it('上一個案例加過的數字不會殘留', () => {
        //如果沒有 beforeEach 重建，這裡會是 2 而不是 1
        expect(counter.increase()).toBe(1)
    })
})

/////////////////////////// 4. 用假物件(mock)隔離外部依賴 ///////////////////////////

describe('vi.fn 假函式', () => {
    //測試不能真的連 Discord、不能真的寄信，所以把那些東西換成假的。
    //vi.fn() 做出來的假函式會記錄自己被呼叫幾次、帶了什麼參數。

    it('可以檢查被呼叫了幾次、帶什麼參數', () => {
        const send = vi.fn()

        send('第一則')
        send('第二則')

        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenCalledWith('第一則')
        expect(send).not.toHaveBeenCalledWith('第三則')
    })

    it('可以指定假函式的回傳值', () => {
        //async () => ... 代表這個假函式回傳 Promise，模擬真實的 API 呼叫
        const fetchName = vi.fn(async () => '楓之谷')
        expect(fetchName).toBeDefined()
    })

    it('整個假物件也可以自己捏', () => {
        //只要實作「被測程式碼真的會用到」的那幾個方法就夠，不必做全套
        const channel = {
            isTextBased: () => true,
            send: vi.fn(async () => ({id: 'msg-1'})),
        }

        expect(channel.isTextBased()).toBe(true)
        expect(channel.send).not.toHaveBeenCalled()
    })
})

/////////////////////////// 5. 非同步的東西要 await ///////////////////////////

describe('非同步', () => {
    const loadTitle = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return '本週副本時段'
    }

    //函式前面加 async，裡面就能用 await。
    //忘了 await 的話，測試會在事情做完之前就結束，然後「莫名其妙通過」。
    it('await 之後再斷言', async () => {
        const title = await loadTitle()
        expect(title).toBe('本週副本時段')
    })

    it('等某件事變成真(輪詢，最多等一秒)', async () => {
        let done = false
        setTimeout(() => {
            done = true
        }, 20)

        //適合用在「觸發之後不知道什麼時候會完成」的情況
        await vi.waitFor(() => {
            expect(done).toBe(true)
        })
    })
})

/////////////////////////// 6. 控制時間 ///////////////////////////

describe('假計時器', () => {
    //測「一小時後會發生什麼」不需要真的等一小時。

    afterEach(() => {
        //用完一定要換回真的計時器，否則後面的測試會跟著壞掉
        vi.useRealTimers()
    })

    it('把時間快轉過去', async () => {
        vi.useFakeTimers()

        const task = vi.fn()
        setTimeout(task, 60000)          //一分鐘後執行

        expect(task).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60001)   //快轉
        expect(task).toHaveBeenCalledTimes(1)
    })
})

/////////////////////////// 7. 這個專案的注意事項 ///////////////////////////

describe('專案限制備忘', () => {
    it('不要在 beforeEach 裡用 vi.resetModules() 重新載入模組', () => {
        //測試 jail 裡這樣寫會卡死到跑不完 —— 只要那條 import 鏈上有 discord.js，
        //每個案例都會把它整包重新載入一次。
        //要換設定(例如換資料檔路徑)請改成「換環境變數 + 清快取」，
        //參考 tests/pollStore.test.js 的 beforeEach。
        expect(true).toBe(true)
    })
})
