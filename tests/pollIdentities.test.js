import {describe, it, expect} from 'vitest'
import {
    identityGroups,
    identityChoices,
    getIdentityGroup,
    identityLabel,
    validateIdentityGroups,
    SELECT_MENU_MAX_OPTIONS,
} from '@/config/pollIdentities'

describe('身分表', () => {
    it('現有設定通過檢查', () => {
        expect(validateIdentityGroups()).toEqual([])
    })

    it('每個群組都不超過 Discord 的選單上限', () => {
        for(const group of Object.values(identityGroups)){
            expect(group.options.length).toBeLessThanOrEqual(SELECT_MENU_MAX_OPTIONS)
        }
    })

    it('選項為空的群組不會出現在指令選項裡', () => {
        const values = identityChoices().map((choice) => choice.value)
        expect(values).toContain('maplestory')
        expect(values).not.toContain('trpg')
    })

    it('value 轉得回中文名稱', () => {
        expect(identityLabel('maplestory', 'paladin')).toBe('聖騎士')
    })

    it('查不到的 value 回傳原始代碼，不會讓人從名單消失', () => {
        expect(identityLabel('maplestory', 'unknown-job')).toBe('unknown-job')
        expect(identityLabel('not-a-group', 'paladin')).toBe('paladin')
    })

    it('查不到的群組回 null', () => {
        expect(getIdentityGroup('not-a-group')).toBeNull()
        expect(getIdentityGroup(null)).toBeNull()
    })
})

describe('validateIdentityGroups', () => {
    it('抓得到重複的 value', () => {
        const problems = validateIdentityGroups({
            demo: {label: 'demo', options: [{value: 'a', label: 'A'}, {value: 'a', label: 'B'}]},
        })
        expect(problems.some((text) => text.includes('重複'))).toBe(true)
    })

    it('抓得到超過選單上限', () => {
        const options = Array.from({length: 26}, (_, i) => ({value: `v${i}`, label: `L${i}`}))
        const problems = validateIdentityGroups({demo: {label: 'demo', options}})
        expect(problems.some((text) => text.includes('上限'))).toBe(true)
    })

    it('抓得到缺少 label 的群組', () => {
        const problems = validateIdentityGroups({demo: {options: []}})
        expect(problems.some((text) => text.includes('label'))).toBe(true)
    })
})
