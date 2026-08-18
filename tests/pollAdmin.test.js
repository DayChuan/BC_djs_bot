import {describe, it, expect} from 'vitest'
import {
    adminId,
    buildAdminDetail,
    buildAdminList,
    buildEditModal,
    parseAdminCustomId,
    parseEditFields,
} from '@/core/pollAdmin'

const poll = (overrides = {}) => ({
    id: 'p_test01',
    title: '本週副本時段',
    description: '請選出你能出席的時段',
    status: 'open',
    closeAt: '2026-08-18T06:00:00.000Z',
    openAt: null,
    weekly: null,
    multi: true,
    options: [{key: 'o0', label: '星期二'}, {key: 'o1', label: '星期三'}],
    votes: {},
    ...overrides,
})

const item = (kind, overrides = {}) => ({kind, poll: poll(overrides)})

const buttonIds = (message, row) =>
    message.components[row].components.map((component) => component.data.custom_id)

describe('parseAdminCustomId', () => {
    it('拆得出動作與投票 id', () => {
        expect(parseAdminCustomId('padm:close:p_abc')).toEqual({action: 'close', pollId: 'p_abc'})
        expect(parseAdminCustomId('padm:back')).toEqual({action: 'back', pollId: null})
    })

    it('不是管理面板的就回 null，不會攔到投票面板的互動', () => {
        expect(parseAdminCustomId('poll:opt:p_abc:e0')).toBeNull()
        expect(parseAdminCustomId(undefined)).toBeNull()
    })

    it('組出來的 id 不超過 Discord 的 100 字元上限', () => {
        expect(adminId('publish', 'p_mf3k9x2a1').length).toBeLessThan(100)
    })
})

describe('buildAdminList', () => {
    it('沒有任何投票時不掛選單', () => {
        const message = buildAdminList([])
        expect(message.components).toEqual([])
        expect(message.embeds[0].data.description).toContain('沒有任何投票')
    })

    it('三種狀態都列得出來，選單值是投票 id', () => {
        const message = buildAdminList([
            item('open'),
            item('pending', {id: 'p_test02', status: 'pending', openAt: '2026-08-23T12:00:00.000Z'}),
            item('archived', {id: 'p_test03', status: 'closed'}),
        ])

        const options = message.components[0].components[0].data.options
        expect(options.map((option) => option.value)).toEqual(['p_test01', 'p_test02', 'p_test03'])
        expect(message.embeds[0].data.description).toContain('🟢 進行中')
        expect(message.embeds[0].data.description).toContain('🕒 排程中')
    })

    it('取消的場次標示為已取消，不跟正常結束的混淆', () => {
        const message = buildAdminList([item('archived', {status: 'cancelled'})])
        expect(message.embeds[0].data.description).toContain('🚫 已取消')
    })

    it('超過 25 場時只列前 25 場並說明還有幾場', () => {
        const items = Array.from({length: 30}, (_, i) => item('archived', {id: `p_x${i}`}))
        const message = buildAdminList(items)

        expect(message.components[0].components[0].data.options).toHaveLength(25)
        expect(message.embeds[0].data.description).toContain('還有 5 場')
    })
})

describe('buildAdminDetail', () => {
    it('進行中的投票給查看/編輯/結算/取消', () => {
        const message = buildAdminDetail(item('open'))
        expect(buttonIds(message, 0)).toEqual([
            'padm:peek:p_test01',
            'padm:edit:p_test01',
            'padm:close:p_test01',
            'padm:cancel:p_test01',
        ])
    })

    it('排程中的投票給立即發布，不給結算(還沒發出去沒得結算)', () => {
        const message = buildAdminDetail(item('pending', {status: 'pending'}))
        const ids = buttonIds(message, 0)
        expect(ids).toContain('padm:publish:p_test01')
        expect(ids).not.toContain('padm:close:p_test01')
    })

    it('已結束的投票給查看/分享/刪除紀錄', () => {
        const ids = buttonIds(buildAdminDetail(item('archived', {status: 'closed'})), 0)
        expect(ids).toEqual([
            'padm:view:p_test01',
            'padm:share:p_test01',
            'padm:purge:p_test01',
        ])
    })

    it('每一頁都有回列表的按鈕，不會卡在詳情畫面', () => {
        expect(buttonIds(buildAdminDetail(item('open')), 1)).toEqual(['padm:back'])
    })

    it('每週設定會用中文顯示', () => {
        const message = buildAdminDetail(item('open', {
            weekly: {openDay: 0, openTime: '20:00', closeDay: 2, closeTime: '22:00'},
        }))
        const field = message.embeds[0].data.fields.find((f) => f.name === '重複')
        expect(field.value).toContain('星期日 20:00 發起')
        expect(field.value).toContain('星期二 22:00 結算')
    })
})

describe('buildEditModal', () => {
    it('五個欄位，標題明示選項不可修改', () => {
        const modal = buildEditModal(poll()).data
        expect(modal.title).toContain('選項無法修改')
        expect(modal.components).toHaveLength(5)
        expect(modal.custom_id).toBe('padm:save:p_test01')
    })

    it('截止時間預先填成台北時間', () => {
        const modal = buildEditModal(poll()).data
        const closeField = modal.components[2].components[0]
        //2026-08-18T06:00Z = 台北 14:00
        expect(closeField.value).toBe('2026-08-18 14:00')
    })
})

describe('parseEditFields', () => {
    const base = {
        title: '新標題',
        description: '新說明',
        closeAt: '2026-08-20 14:00',
        weeklyOpen: '',
        weeklyClose: '',
    }

    it('基本欄位轉成 patch，截止時間換算回 UTC', () => {
        const {patch} = parseEditFields(poll(), base)
        expect(patch.title).toBe('新標題')
        expect(patch.closeAt).toBe('2026-08-20T06:00:00.000Z')
        expect(patch.weekly).toBeNull()
    })

    it('標題空白要擋下來', () => {
        const {error} = parseEditFields(poll(), {...base, title: '   '})
        expect(error).toContain('標題')
    })

    it('截止時間格式錯誤要擋下來，而且不做任何修改', () => {
        const {patch, error} = parseEditFields(poll(), {...base, closeAt: '2026/08/20 14:00'})
        expect(patch).toBeUndefined()
        expect(error).toContain('YYYY-MM-DD HH:mm')
    })

    it('每週設定兩格都填才算數', () => {
        const {error} = parseEditFields(poll(), {...base, weeklyOpen: '0,20:00'})
        expect(error).toContain('都填')
    })

    it('每週設定填對時轉成 weekly 物件', () => {
        const {patch} = parseEditFields(poll(), {
            ...base,
            weeklyOpen: '0,20:00',
            weeklyClose: '2,22:00',
        })
        expect(patch.weekly).toEqual({
            openDay: 0, openTime: '20:00', closeDay: 2, closeTime: '22:00',
        })
    })

    it('星期填超出範圍要擋下來', () => {
        const {error} = parseEditFields(poll(), {
            ...base,
            weeklyOpen: '9,20:00',
            weeklyClose: '2,22:00',
        })
        expect(error).toContain('每週發起')
    })

    it('排程中的投票改了每週設定，會重算下一次發起時間', () => {
        const pending = poll({status: 'pending', closeAt: null, openAt: '2026-01-01T00:00:00.000Z'})
        const {patch} = parseEditFields(pending, {
            ...base,
            closeAt: '',
            weeklyOpen: '0,20:00',
            weeklyClose: '2,22:00',
        })
        //沒重算的話會停在過去的時間，發布排程等於立刻觸發
        expect(new Date(patch.openAt).getTime()).toBeGreaterThan(Date.now())
    })

    it('兩格都留空代表取消每週重複', () => {
        const {patch} = parseEditFields(poll(), {...base, weeklyOpen: '', weeklyClose: ''})
        expect(patch.weekly).toBeNull()
    })
})
