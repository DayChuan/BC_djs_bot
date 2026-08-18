import {describe, it, expect} from 'vitest'
import {
    buildClosedMessage,
    buildHistoryList,
    buildMemberPanel,
    buildPollMessage,
    buildResultMessage,
    customId,
    parsePollCustomId,
    percentBar,
} from '@/core/pollRender'

const samplePoll = (overrides = {}) => ({
    id: 'p_test01',
    type: 'standard',
    channelId: '111',
    messageId: '222',
    title: '本週副本時段',
    description: '請選出你能出席的時段',
    multi: true,
    multiChar: false,
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

//把某一列元件的 data 取出來，測試比較好讀
const rowData = (message, row, index = 0) => message.components[row].components[index].data

describe('parsePollCustomId', () => {
    it('認得各種動作', () => {
        expect(parsePollCustomId('poll:open:p_abc')).toEqual({kind: 'open', pollId: 'p_abc', entryId: null})
        expect(parsePollCustomId('poll:peek:p_abc')).toEqual({kind: 'peek', pollId: 'p_abc', entryId: null})
        expect(parsePollCustomId('poll:opt:p_abc:e1')).toEqual({kind: 'opt', pollId: 'p_abc', entryId: 'e1'})
    })

    it('改版前的舊訊息沒有角色編號，視為第一筆', () => {
        //舊投票訊息掛的是 poll:opt:<id>，升級後照樣要點得動
        expect(parsePollCustomId('poll:opt:p_abc')).toEqual({kind: 'opt', pollId: 'p_abc', entryId: null})
    })

    it('不是投票的 customId 回 null，交給別的處理器', () => {
        expect(parsePollCustomId('role-panel-select')).toBeNull()
        expect(parsePollCustomId('poll:nonsense:p_abc')).toBeNull()
        expect(parsePollCustomId(undefined)).toBeNull()
    })

    it('組出來的 customId 不會超過 Discord 的 100 字元上限', () => {
        expect(customId('opt', 'p_mf3k9x2a1', 'e10').length).toBeLessThan(100)
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

describe('buildPollMessage（頻道裡的公開訊息）', () => {
    it('只有按鈕，不掛任何選單', () => {
        const message = buildPollMessage(samplePoll())
        expect(message.components).toHaveLength(1)
        expect(rowData(message, 0).custom_id).toBe('poll:open:p_test01')
    })

    it('允許中途查看時多一顆查看按鈕', () => {
        const message = buildPollMessage(samplePoll())
        expect(message.components[0].components).toHaveLength(2)
        expect(rowData(message, 0, 1).custom_id).toBe('poll:peek:p_test01')
    })

    it('peek 設為 false 時沒有查看按鈕', () => {
        const message = buildPollMessage(samplePoll({peek: false}))
        expect(message.components[0].components).toHaveLength(1)
    })

    it('多角色投票的按鈕文字不一樣，說明也會提到上限', () => {
        const message = buildPollMessage(samplePoll({multiChar: true}))
        expect(rowData(message, 0).label).toContain('角色')
        expect(message.embeds[0].data.description).toContain('多個角色')
    })
})

describe('buildMemberPanel（個人面板）', () => {
    it('沒投過票時給一組空的選單', () => {
        const panel = buildMemberPanel(samplePoll(), 'u1')
        expect(rowData(panel, 0).custom_id).toBe('poll:opt:p_test01:e0')
        expect(rowData(panel, 0).min_values).toBe(0)
        expect(rowData(panel, 0).max_values).toBe(3)
    })

    it('單選投票的選單上限是 1', () => {
        const panel = buildMemberPanel(samplePoll({multi: false}), 'u1')
        expect(rowData(panel, 0).max_values).toBe(1)
    })

    it('已選的選項會預先勾起來', () => {
        const poll = samplePoll({votes: {u1: [{entryId: 'e0', options: ['o1'], identity: null}]}})
        const panel = buildMemberPanel(poll, 'u1')
        const options = rowData(panel, 0).options
        expect(options.find((option) => option.value === 'o1').default).toBe(true)
        expect(options.find((option) => option.value === 'o0').default).toBeFalsy()
    })

    it('有身分群組時多一列身分選單', () => {
        const panel = buildMemberPanel(samplePoll({identityGroup: 'maplestory'}), 'u1')
        expect(rowData(panel, 1).custom_id).toBe('poll:idt:p_test01:e0')
    })

    it('身分群組是空的(TRPG)時不會生出沒有選項的選單', () => {
        const panel = buildMemberPanel(samplePoll({identityGroup: 'trpg'}), 'u1')
        expect(panel.components).toHaveLength(1)
    })

    it('單角色投票也有清除登記的按鈕', () => {
        const panel = buildMemberPanel(samplePoll(), 'u1')
        const buttons = panel.components[panel.components.length - 1].components
        //沒有這顆的話，想撤銷登記只能把選項一個一個點掉
        expect(buttons).toHaveLength(1)
        expect(buttons[0].data.custom_id).toBe('poll:del:p_test01:e0')
        expect(buttons[0].data.label).toBe('清除我的登記')
    })

    it('多角色投票有新增與清除，只有一個角色時不出現左右鍵', () => {
        const panel = buildMemberPanel(samplePoll({multiChar: true}), 'u1')
        const buttons = panel.components[panel.components.length - 1].components
        expect(buttons.map((button) => button.data.custom_id)).toEqual([
            'poll:add:p_test01',
            'poll:del:p_test01:e0',
        ])
    })

    it('兩個以上角色時出現切換選單與刪除按鈕', () => {
        const poll = samplePoll({
            multiChar: true,
            identityGroup: 'maplestory',
            votes: {
                u1: [
                    {entryId: 'e0', options: ['o0'], identity: 'paladin'},
                    {entryId: 'e1', options: ['o1'], identity: 'arch-mage'},
                ],
            },
        })
        const panel = buildMemberPanel(poll, 'u1', 'e1')

        //選項、身分、切換、按鈕共四列，沒有超過 Discord 的五列上限
        expect(panel.components).toHaveLength(4)
        expect(rowData(panel, 2).custom_id).toBe('poll:sel:p_test01')

        const buttons = panel.components[3].components
        //左右鍵指向前一個/後一個角色，循環，所以兩顆都指向 e0
        expect(buttons.map((button) => button.data.custom_id)).toEqual([
            'poll:add:p_test01',
            'poll:del:p_test01:e1',
            'poll:sel:p_test01:e0',
            'poll:sel:p_test01:e0',
        ])
        expect(buttons[1].data.label).toBe('刪除這個角色')
    })

    it('三個角色時左右鍵分別指向前後兩個', () => {
        const poll = samplePoll({
            multiChar: true,
            votes: {
                u1: [
                    {entryId: 'e0', options: ['o0'], identity: null},
                    {entryId: 'e1', options: ['o1'], identity: null},
                    {entryId: 'e2', options: ['o2'], identity: null},
                ],
            },
        })
        const panel = buildMemberPanel(poll, 'u1', 'e1')
        const buttons = panel.components[panel.components.length - 1].components
        expect(buttons[2].data.custom_id).toBe('poll:sel:p_test01:e0')
        expect(buttons[3].data.custom_id).toBe('poll:sel:p_test01:e2')
    })

    it('指定的角色會成為正在編輯的那一個', () => {
        const poll = samplePoll({
            multiChar: true,
            votes: {
                u1: [
                    {entryId: 'e0', options: ['o0'], identity: null},
                    {entryId: 'e1', options: ['o2'], identity: null},
                ],
            },
        })
        const panel = buildMemberPanel(poll, 'u1', 'e1')
        expect(rowData(panel, 0).custom_id).toBe('poll:opt:p_test01:e1')
        expect(rowData(panel, 0).options.find((option) => option.value === 'o2').default).toBe(true)
    })

    it('指定的角色不存在時退回第一筆，不會整個壞掉', () => {
        const poll = samplePoll({votes: {u1: [{entryId: 'e0', options: ['o0'], identity: null}]}})
        const panel = buildMemberPanel(poll, 'u1', 'e99')
        expect(rowData(panel, 0).custom_id).toBe('poll:opt:p_test01:e0')
    })

    it('達到角色數上限時新增按鈕會停用', () => {
        const votes = {u1: Array.from({length: 10}, (_, i) => ({
            entryId: `e${i}`, options: ['o0'], identity: null,
        }))}
        const panel = buildMemberPanel(samplePoll({multiChar: true, votes}), 'u1')
        const add = panel.components[panel.components.length - 1].components[0].data
        expect(add.disabled).toBe(true)
    })

    it('讀得懂改版前的舊資料(一人一筆的物件)', () => {
        const poll = samplePoll({votes: {u1: {options: ['o1'], identity: null}}})
        const panel = buildMemberPanel(poll, 'u1')
        expect(rowData(panel, 0).options.find((option) => option.value === 'o1').default).toBe(true)
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
                u1: [{entryId: 'e0', options: ['o1'], identity: null}],
                u2: [{entryId: 'e0', options: ['o1'], identity: null}],
                u3: [{entryId: 'e0', options: ['o0'], identity: null}],
            },
        })

        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.description).toContain('最高票：**星期三**')
        expect(embed.fields[0].name).toContain('星期三')
        expect(embed.fields[0].value).toContain('<@u1>')
    })

    it('讀得懂改版前的舊資料(一人一筆的物件)', () => {
        const poll = samplePoll({votes: {u1: {options: ['o0'], identity: null}}})
        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.footer.text).toBe('共 1 人投票')
        expect(embed.fields[0].value).toContain('<@u1>')
    })

    it('同票數時標示為並列', () => {
        const poll = samplePoll({
            votes: {
                u1: [{entryId: 'e0', options: ['o0'], identity: null}],
                u2: [{entryId: 'e0', options: ['o1'], identity: null}],
            },
        })
        expect(buildResultMessage(poll).embeds[0].data.description).toContain('並列')
    })

    it('有身分時按身分分組，並附上身分統計', () => {
        const poll = samplePoll({
            identityGroup: 'maplestory',
            votes: {
                u1: [{entryId: 'e0', options: ['o0'], identity: 'paladin'}],
                u2: [{entryId: 'e0', options: ['o0'], identity: 'paladin'}],
                u3: [{entryId: 'e0', options: ['o0'], identity: null}],
            },
        })

        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.fields[0].value).toContain('**聖騎士**（2）')
        expect(embed.fields[0].value).toContain('未選身分')

        const summary = embed.fields.find((field) => field.name === '身分統計')
        expect(summary.value).toContain('聖騎士　2')
    })

    it('多角色時同時顯示人數與角色數', () => {
        const poll = samplePoll({
            multiChar: true,
            identityGroup: 'maplestory',
            votes: {
                u1: [
                    {entryId: 'e0', options: ['o0'], identity: 'paladin'},
                    {entryId: 'e1', options: ['o0'], identity: 'arch-mage'},
                ],
                u2: [{entryId: 'e0', options: ['o0'], identity: 'paladin'}],
            },
        })

        const embed = buildResultMessage(poll).embeds[0].data
        expect(embed.footer.text).toBe('共 2 人 / 3 個角色投票')
        //同一人的兩隻角色都要列出來，各自掛在自己的職業底下
        expect(embed.fields[0].value).toContain('**聖騎士**（2）')
        expect(embed.fields[0].value).toContain('**主教**（1）')
    })

    it('沒有身分群組時，同一人的多個角色只列一次', () => {
        const poll = samplePoll({
            multiChar: true,
            votes: {
                u1: [
                    {entryId: 'e0', options: ['o0'], identity: null},
                    {entryId: 'e1', options: ['o0'], identity: null},
                ],
            },
        })
        const embed = buildResultMessage(poll).embeds[0].data
        //票數算兩隻，但名單只列一次 —— 列兩個一樣的 mention 會讓人以為壞了
        expect(embed.fields[0].name).toContain('2 票')
        expect(embed.fields[0].value).toBe('<@u1>')
    })

    it('即時版與結算版用同一套統計，只有標題與註記不同', () => {
        const poll = samplePoll({votes: {u1: [{entryId: 'e0', options: ['o0'], identity: null}]}})

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

describe('buildClosedMessage', () => {
    it('把元件清空，避免有人繼續點已截止的投票', () => {
        expect(buildClosedMessage(samplePoll()).components).toEqual([])
    })
})

describe('buildHistoryList', () => {
    const record = (overrides = {}) => ({
        id: 'p_old001',
        title: '上週副本時段',
        closeAt: '2026-08-11T12:00:00.000Z',
        multiChar: false,
        result: {voterCount: 5, entryCount: 5},
        ...overrides,
    })

    it('列出每場的 id、標題與人數', () => {
        const embed = buildHistoryList([record()]).embeds[0].data
        expect(embed.fields[0].name).toBe('上週副本時段')
        expect(embed.fields[0].value).toContain('p_old001')
        expect(embed.fields[0].value).toContain('5 人投票')
    })

    it('多角色的場次顯示人數與角色數', () => {
        const embed = buildHistoryList([
            record({multiChar: true, result: {voterCount: 3, entryCount: 7}}),
        ]).embeds[0].data
        expect(embed.fields[0].value).toContain('3 人 / 7 個角色')
    })

    it('沒有紀錄時給明確訊息', () => {
        expect(buildHistoryList([]).embeds[0].data.description).toContain('沒有任何歷史投票')
    })

    it('有關鍵字但查無結果時，訊息要提到關鍵字', () => {
        const embed = buildHistoryList([], {keyword: 'TRPG'}).embeds[0].data
        expect(embed.description).toContain('TRPG')
    })
})
