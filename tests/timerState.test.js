import {describe, it, expect} from 'vitest'
import {
    anyRunning,
    createPanel,
    formatRemaining,
    isExpired,
    isIdle,
    remainingSeconds,
    startTimer,
    stopAll,
    stopTimer,
    tick,
    pressTimer,
    touch,
} from '@/core/timerState'
import {
    PANEL_IDLE_MS,
    PANEL_MAX_MS,
    SKILLS,
    WARN_DISPLAY_SECONDS,
    WARN_SECONDS,
} from '@/config/horntail'

//timerState 不呼叫 Date.now()，時間一律從外面傳進來，
//所以這裡用固定的假時間戳推進，不必真的等 60 秒，也不用 vi.useFakeTimers()。
const T0 = 1_700_000_000_000
const at = (seconds) => T0 + (seconds * 1000)

//秒數從設定檔取，之後調整招式秒數時測試不用跟著改
const secondsOf = (key) => SKILLS.find((skill) => skill.key === key).seconds

const panelWith = (key, now = T0) => {
    const panel = createPanel('channel-1', now)
    startTimer(panel, key, now)
    return panel
}

const remainingOf = (panel, key, now) => remainingSeconds(panel.timers[key], now)

describe('起始狀態', () => {
    it('三個招式都沒在跑，顯示各自的初始秒數', () => {
        const panel = createPanel('channel-1', T0)

        expect(anyRunning(panel)).toBe(false)
        for(const skill of SKILLS){
            expect(remainingOf(panel, skill.key, at(30))).toBe(skill.seconds)
        }
    })

    it('設定檔裡的三個招式都建出了計時器', () => {
        const panel = createPanel('channel-1', T0)
        expect(Object.keys(panel.timers)).toEqual(SKILLS.map((skill) => skill.key))
    })
})

describe('倒數', () => {
    it('start 之後剩餘秒數隨時間遞減', () => {
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        expect(remainingOf(panel, 'fire', T0)).toBe(total)
        expect(remainingOf(panel, 'fire', at(1))).toBe(total - 1)
        expect(remainingOf(panel, 'fire', at(10))).toBe(total - 10)
    })

    it('用結束時間重算，中間漏掉幾次 tick 也不會算錯', () => {
        //累加 tick 次數的寫法在這裡就會偏掉；絕對時間戳不會。
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        tick(panel, at(1))
        //刻意跳過 2~19 秒的 tick
        tick(panel, at(20))

        expect(remainingOf(panel, 'fire', at(20))).toBe(total - 20)
    })
})

describe('剩 WARN_SECONDS 秒的提醒', () => {
    const total = secondsOf('fire')
    const warnAt = total - WARN_SECONDS      //剛好剩 WARN_SECONDS 秒的那一刻

    it('跨進 WARN_SECONDS 時回報一次', () => {
        const panel = panelWith('fire')

        expect(tick(panel, at(warnAt - 1)).warned).toEqual([])
        expect(remainingOf(panel, 'fire', at(warnAt))).toBe(WARN_SECONDS)
        expect(tick(panel, at(warnAt)).warned).toEqual(['fire'])
    })

    it('同一輪的後續 tick 不會重複觸發', () => {
        const panel = panelWith('fire')
        tick(panel, at(warnAt))

        for(let s = warnAt + 1; s < total; s += 1){
            expect(tick(panel, at(s)).warned).toEqual([])
        }
    })

    it('歸零那一刻不算提醒(剩 0 秒不再唸)', () => {
        const panel = panelWith('fire')
        tick(panel, at(warnAt))

        expect(tick(panel, at(total)).warned).toEqual([])
    })

    it('下一輪會重新提醒一次', () => {
        const panel = panelWith('fire')
        tick(panel, at(warnAt))
        tick(panel, at(total))                       //換輪

        expect(tick(panel, at(total + warnAt)).warned).toEqual(['fire'])
    })
})

describe('自動換輪', () => {
    it('歸零後重置為初始秒數並繼續跑', () => {
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        const result = tick(panel, at(total))

        expect(result.rolled).toEqual(['fire'])
        expect(panel.timers.fire.running).toBe(true)
        expect(panel.timers.fire.rounds).toBe(1)
        expect(remainingOf(panel, 'fire', at(total))).toBe(total)
        expect(remainingOf(panel, 'fire', at(total + 5))).toBe(total - 5)
    })

    it('連續跑三輪，相位不會被 tick 的誤差推著跑', () => {
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        //每秒 tick 一次，跑滿三輪
        for(let s = 1; s <= total * 3; s += 1) tick(panel, at(s))

        expect(panel.timers.fire.rounds).toBe(3)
        expect(remainingOf(panel, 'fire', at(total * 3))).toBe(total)
    })

    it('落後超過一整輪時重新對時，不會一次補跳好幾輪', () => {
        //行程卡住(或機器休眠)之後的情況：正確的行為是從現在重新開始一輪。
        const panel = panelWith('fire')
        const total = secondsOf('fire')
        const late = total * 5

        const result = tick(panel, at(late))

        expect(result.rolled).toEqual(['fire'])
        expect(panel.timers.fire.rounds).toBe(1)
        expect(remainingOf(panel, 'fire', at(late))).toBe(total)
    })
})

describe('停止與重新開始', () => {
    it('stop 之後不再遞減，也不再回報任何事件', () => {
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        stopTimer(panel, 'fire')

        expect(anyRunning(panel)).toBe(false)
        expect(remainingOf(panel, 'fire', at(total * 2))).toBe(total)
        expect(tick(panel, at(total * 2))).toEqual({warned: [], rolled: []})
    })

    it('再 start 從初始秒數重新開始', () => {
        const panel = panelWith('fire')
        const total = secondsOf('fire')

        tick(panel, at(total - WARN_SECONDS))       //先讓這一輪提醒過
        stopTimer(panel, 'fire')
        startTimer(panel, 'fire', at(100))

        expect(remainingOf(panel, 'fire', at(100))).toBe(total)
        expect(panel.timers.fire.rounds).toBe(0)
        //重開之後提醒旗標要跟著清掉，否則新的一輪不會唸
        expect(tick(panel, at(100 + total - WARN_SECONDS)).warned).toEqual(['fire'])
    })

    it('按一下開始，再按一下從頭重算（不是停止）', () => {
        const panel = createPanel('channel-1', T0)

        pressTimer(panel, 'fire', T0)
        expect(panel.timers.fire.running).toBe(true)

        //跑了 10 秒之後再按一次：仍然在跑，而且剩餘秒數回到初始值。
        //打王遇到 delay 時要的是重新計時，舊語意得按兩次才做得到。
        pressTimer(panel, 'fire', at(10))
        expect(panel.timers.fire.running).toBe(true)
        expect(remainingOf(panel, 'fire', at(10))).toBe(secondsOf('fire'))

        //重算之後這一輪的提醒也要重來，不能沿用上一輪的 warned
        expect(panel.timers.fire.warned).toBe(false)
    })

    it('認不得的招式 key 回 null，不丟例外', () => {
        const panel = createPanel('channel-1', T0)

        expect(startTimer(panel, 'nope', T0)).toBe(null)
        expect(pressTimer(panel, 'nope', T0)).toBe(null)
        expect(stopTimer(panel, 'nope')).toBe(null)
        expect(anyRunning(panel)).toBe(false)
    })
})

describe('三個招式各自獨立', () => {
    it('停掉其中一個不影響另外兩個', () => {
        const panel = createPanel('channel-1', T0)
        for(const skill of SKILLS) startTimer(panel, skill.key, T0)

        stopTimer(panel, 'dispel')
        tick(panel, at(10))

        expect(remainingOf(panel, 'fire', at(10))).toBe(secondsOf('fire') - 10)
        expect(remainingOf(panel, 'lock', at(10))).toBe(secondsOf('lock') - 10)
        expect(remainingOf(panel, 'dispel', at(10))).toBe(secondsOf('dispel'))
        expect(anyRunning(panel)).toBe(true)
    })

    it('秒數不同的招式各自換輪，不會互相帶動', () => {
        const panel = createPanel('channel-1', T0)
        startTimer(panel, 'fire', T0)
        startTimer(panel, 'lock', T0)

        //只有黑鎖(較短)會在它自己的秒數上換輪
        const result = tick(panel, at(secondsOf('lock')))

        expect(result.rolled).toEqual(['lock'])
        expect(panel.timers.fire.rounds).toBe(0)
    })

    it('stopAll 把三個都停掉', () => {
        const panel = createPanel('channel-1', T0)
        for(const skill of SKILLS) startTimer(panel, skill.key, T0)

        stopAll(panel)

        expect(anyRunning(panel)).toBe(false)
    })
})

describe('面板生命週期', () => {
    it('兩小時後過期', () => {
        const panel = createPanel('channel-1', T0)

        expect(isExpired(panel, T0 + PANEL_MAX_MS - 1)).toBe(false)
        expect(isExpired(panel, T0 + PANEL_MAX_MS)).toBe(true)
    })

    it('沒人按按鈕滿 30 分鐘就算閒置，按一下就重新計算', () => {
        const panel = createPanel('channel-1', T0)

        expect(isIdle(panel, T0 + PANEL_IDLE_MS - 1)).toBe(false)
        expect(isIdle(panel, T0 + PANEL_IDLE_MS)).toBe(true)

        touch(panel, T0 + PANEL_IDLE_MS)
        expect(isIdle(panel, T0 + PANEL_IDLE_MS)).toBe(false)
    })
})

describe('招式設定', () => {
    it('每一招都有 key / label / voice / emoji / seconds', () => {
        for(const skill of SKILLS){
            expect(skill.key).toMatch(/^[a-z]+$/)
            expect(skill.label.length).toBeGreaterThan(0)
            //TTS 唸的短名不能是空的，否則語音提醒會發出一則空訊息
            expect(skill.voice.length).toBeGreaterThan(0)
            expect(skill.emoji.length).toBeGreaterThan(0)
            expect(skill.seconds).toBeGreaterThan(WARN_SECONDS)
        }
    })

    it('customId 用的 key 不重複', () => {
        expect(new Set(SKILLS.map((skill) => skill.key)).size).toBe(SKILLS.length)
    })

    it('實際觸發的秒數不會早於面板上寫的', () => {
        //2026-08-24 兩者都是 5：發訊者名稱 TTS 唸不出來，原本補的兩秒開場並不存在。
        //保留兩個常數是為了「之後又需要補償時只改 WARN_SECONDS」。
        expect(WARN_SECONDS).toBeGreaterThanOrEqual(WARN_DISPLAY_SECONDS)
    })

    it('計時器把 voice 與 emoji 帶進狀態，render 不必再回頭查設定檔', () => {
        const panel = createPanel('channel-1', T0)
        for(const skill of SKILLS){
            expect(panel.timers[skill.key].voice).toBe(skill.voice)
            expect(panel.timers[skill.key].emoji).toBe(skill.emoji)
        }
    })
})

describe('formatRemaining', () => {
    it('90 秒顯示為 1:30', () => {
        expect(formatRemaining(90)).toBe('1:30')
    })

    it('秒數補零', () => {
        expect(formatRemaining(5)).toBe('0:05')
        expect(formatRemaining(60)).toBe('1:00')
        expect(formatRemaining(0)).toBe('0:00')
    })

    it('負數當作 0，不會出現 -1:-5 這種畫面', () => {
        expect(formatRemaining(-3)).toBe('0:00')
    })
})
