import {describe, it, expect} from 'vitest'
import {
    buildBallotReply,
    buildClosedMessage,
    buildPollMessage,
    buildResultMessage,
    parsePollCustomId,
    percentBar,
    POLL_IDENTITY_PREFIX,
    POLL_OPTION_PREFIX,
    POLL_PEEK_PREFIX,
} from '@/core/pollRender'

const samplePoll = (overrides = {}) => ({
    id: 'p_test01',
    type: 'standard',
    channelId: '111',
    messageId: '222',
    title: '本週副本時段',
    description: '請選出你能出席的時段',
    multi: true,
    identityGroup: null,
    status: 'open',
    closeAt: '2026-08-25T12:00:00.000Z',
    weekly: null,
    options: [
        {key: 'o0', label: '星期二'},
        {key: 'o1', label: '星期三'},
        {key: 'o2', label: '星期四'},
    ],
    votes: {},
    ...overrides,
})

describe('parsePollCustomId', () => {
    it('認得選項選單與身分選單', () => {
        expect(parsePollCustomId(`${POLL_OPTION_PREFIX}p_abc`)).toEqual({kind: 'option', pollId: 'p_abc'})
        expect(parsePollCustomId(`${POLL_IDENTITY_PREFIX}p_abc`)).toEqual({kind: 'identity', pollId: 'p_abc'})
    })

    it('不是投票的 customId 回 null，交給別的處理器', () => {
        expect(parsePollCustomId('role-panel-select')).toBeNull()
        expect(parsePollCustomId(undefined)).toBeNull()
    })

    it('組出來的 customId 不會超過 Discord 的 100 字元上限', () => {
        expect(`${POLL_OPTION_PREFIX}p_mf3k9x2a1`.length).toBeLessThan(100)
    })
})

describe('percentBar', () => {
    it('0% 與 100% 的兩端', () => {
        expect(percentBar(0)).toBe('░░░░░░░░░░')
        expect(percentBar(100)).toBe('██████████')
    })

    it('一半就是一半', () => {
        expect(percentBar(50)).toBe('█████░░░░░')
    })

    it('超出範圍的值會被夾住，不會產生長度不一的長條', () => {
        expect(percentBar(-20)).toHaveLength(10)
        expect(percentBar(999)).toHaveLength(10)
    })
})

describe('buildPollMessage', () => {
    it('沒有身分群組時只有一列選單，外加一列查看按鈕', () => {
        const message = buildPollMessage(samplePoll())
        expect(message.components).toHaveLength(2)

        const select = message.components[0].components[0].data
        expect(select.custom_id).toBe(`${POLL_OPTION_PREFIX}p_test01`)
        //可以複選 → 上限等於選項數；下限 0 → 可以取消投票
        expect(select.max_values).toBe(3)
        expect(select.min_values).toBe(0)
    })

    it('單選投票的選單上限是 1', () => {
        const message = buildPollMessage(samplePoll({multi: false}))
        expect(message.components[0].components[0].data.max_values).toBe(1)
    })

    it('有身分群組時多一列身分選單', () => {
        const message = buildPollMessage(samplePoll({identityGroup: 'maplestory'}))
        expect(message.components).toHaveLength(3)
        expect(message.components[1].components[0].data.custom_id)
            .toBe(`${POLL_IDENTITY_PREFIX}p_test01`)
    })

    it('身分群組是空的(TRPG)時不會生出沒有選項的選單', () => {
        const message = buildPollMessage(samplePoll({identityGroup: 'trpg'}))
        expect(message.components).toHaveLength(2)
    })
})

describe('buildResultMessage', () => {
    it('沒有人投票時給明確訊息，不是空白的報表', () => {
        const message = buildResultMessage(samplePoll())
        expect(message.embeds[0].data.description).toContain('沒有任何人投票')
        expect(message.embeds[0].data.fields).toBeUndefined()
    })

    it('依票數由高到低排，最高票寫在說明裡', () => {
        const poll = samplePoll({
            votes: {
                u1: {options: ['o1'], identity: null},
                u2: {options: ['o1'], identity: null},
                u3: {options: ['o0'], identity: null},
            },
        })

        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.description).toContain('最高票：**星期三**')
        expect(embed.fields[0].name).toContain('星期三')
        expect(embed.fields[0].value).toContain('<@u1>')
    })

    it('同票數時標示為並列', () => {
        const poll = samplePoll({
            votes: {
                u1: {options: ['o0'], identity: null},
                u2: {options: ['o1'], identity: null},
            },
        })
        expect(buildResultMessage(poll).embeds[0].data.description).toContain('並列')
    })

    it('有身分時按身分分組，並附上身分統計', () => {
        const poll = samplePoll({
            identityGroup: 'maplestory',
            votes: {
                u1: {options: ['o0'], identity: 'paladin'},
                u2: {options: ['o0'], identity: 'paladin'},
                u3: {options: ['o0'], identity: null},
            },
        })

        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.fields[0].value).toContain('**聖騎士**（2）')
        expect(embed.fields[0].value).toContain('未選身分')

        const summary = embed.fields.find((field) => field.name === '身分統計')
        expect(summary.value).toContain('聖騎士　2 人')
    })

    it('沒有身分群組時不會出現身分統計欄位', () => {
        const poll = samplePoll({votes: {u1: {options: ['o0'], identity: null}}})
        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.fields.some((field) => field.name === '身分統計')).toBe(false)
    })
})

describe('buildClosedMessage', () => {
    it('把元件清空，避免有人繼續點已截止的投票', () => {
        expect(buildClosedMessage(samplePoll()).components).toEqual([])
    })
})

describe('buildBallotReply', () => {
    it('列出自己選了什麼與目前統計', () => {
        const poll = samplePoll({
            votes: {
                u1: {options: ['o0', 'o2'], identity: null},
                u2: {options: ['o0'], identity: null},
            },
        })

        const reply = buildBallotReply(poll, 'u1')
        expect(reply).toContain('已登記：**星期二、星期四**')
        expect(reply).toContain('目前 2 人投票')
    })

    it('取消投票時說明是取消，不要顯示空白的已登記', () => {
        expect(buildBallotReply(samplePoll(), 'u1')).toContain('已取消你的投票')
    })

    it('有身分群組但還沒選身分時會提醒', () => {
        const poll = samplePoll({
            identityGroup: 'maplestory',
            votes: {u1: {options: ['o0'], identity: null}},
        })
        expect(buildBallotReply(poll, 'u1')).toContain('身分：尚未選擇')
    })
})

describe('中途查看結果（peek）', () => {
    it('預設掛上查看按鈕', () => {
        //舊資料沒有 peek 欄位時也要視為允許，不能整個功能消失
        const message = buildPollMessage(samplePoll())
        const button = message.components[1].components[0].data
        expect(button.custom_id).toBe(`${POLL_PEEK_PREFIX}p_test01`)
        expect(button.label).toBe('查看目前結果')
    })

    it('peek 設為 false 時不掛按鈕', () => {
        const message = buildPollMessage(samplePoll({peek: false}))
        //只剩選項選單那一列
        expect(message.components).toHaveLength(1)
    })

    it('有身分選單時按鈕排在第三列', () => {
        const message = buildPollMessage(samplePoll({identityGroup: 'maplestory'}))
        expect(message.components).toHaveLength(3)
        expect(message.components[2].components[0].data.custom_id)
            .toBe(`${POLL_PEEK_PREFIX}p_test01`)
    })

    it('parsePollCustomId 認得查看按鈕', () => {
        expect(parsePollCustomId(`${POLL_PEEK_PREFIX}p_abc`)).toEqual({kind: 'peek', pollId: 'p_abc'})
    })

    it('即時版與結算版用同一套統計，只有標題與註記不同', () => {
        const poll = samplePoll({votes: {u1: {options: ['o0'], identity: null}}})

        const live = buildResultMessage(poll, {live: true}).embeds[0].data
        const final = buildResultMessage(poll).embeds[0].data

        expect(live.title).toContain('目前結果')
        expect(final.title).toContain('投票結果')
        expect(live.footer.text).toContain('尚未截止')
        //欄位內容必須一模一樣，否則中途看到的跟最後公布的會對不起來
        expect(live.fields).toEqual(final.fields)
    })

    it('即時版沒有人投票時給的是「目前還沒有人投票」', () => {
        const embed = buildResultMessage(samplePoll(), {live: true}).embeds[0].data
        expect(embed.description).toContain('目前還沒有人投票')
    })
})
