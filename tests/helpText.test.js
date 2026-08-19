import {describe, it, expect} from 'vitest'
import {buildHelpText, filterUsable, toHelpEntry} from '@/core/helpText'

//用 SlashCommandBuilder.toJSON() 的實際形狀當測資，不 import discord.js。
const ADMINISTRATOR = '8'
const MANAGE_ROLES = '268435456'

const open = {name: 'sip_sip', description: 'sip command'}
const adminOnly = {name: 'poll_admin', description: '投票管理', default_member_permissions: ADMINISTRATOR}
const roleOnly = {
    name: 'selfrole',
    description: '管理可自助領取的身分組清單',
    default_member_permissions: MANAGE_ROLES,
    options: [
        {type: 1, name: 'add', description: '加入清單'},
        {type: 1, name: 'list', description: '列出清單'},
        {type: 3, name: 'noise', description: '這是選項不是子指令'},
    ],
}

//只認得 MANAGE_ROLES 的成員
const roleManager = (bits) => bits === MANAGE_ROLES

describe('toHelpEntry', () => {
    it('沒設權限時 permissions 是 null', () => {
        expect(toHelpEntry(open).permissions).toBe(null)
    })

    it('只挑出子指令，一般選項不算', () => {
        expect(toHelpEntry(roleOnly).subcommands).toEqual([
            {name: 'add', description: '加入清單'},
            {name: 'list', description: '列出清單'},
        ])
    })

    it('吃得下 SlashCommandBuilder(有 toJSON 的物件)', () => {
        const builder = {toJSON: () => open}
        expect(toHelpEntry(builder).name).toBe('sip_sip')
    })
})

describe('filterUsable', () => {
    const entries = [open, adminOnly, roleOnly].map(toHelpEntry)

    it('沒有權限需求的指令所有人都看得到', () => {
        const names = filterUsable(entries, () => false).map((entry) => entry.name)
        expect(names).toEqual(['sip_sip'])
    })

    it('只顯示成員權限涵蓋得到的指令', () => {
        const names = filterUsable(entries, roleManager).map((entry) => entry.name)
        expect(names).toEqual(['sip_sip', 'selfrole'])
    })

    it('管理員(權限判斷一律為真)看得到全部', () => {
        const names = filterUsable(entries, () => true).map((entry) => entry.name)
        expect(names).toEqual(['sip_sip', 'poll_admin', 'selfrole'])
    })
})

describe('buildHelpText', () => {
    it('列出的指令數量與內容都只含看得到的部分', () => {
        const text = buildHelpText([open, adminOnly, roleOnly], roleManager)

        expect(text).toContain('共 2 個')
        expect(text).toContain('`/sip_sip`')
        expect(text).toContain('`/selfrole`')
        expect(text).not.toContain('poll_admin')
    })

    it('有子指令的會一併列出', () => {
        const text = buildHelpText([roleOnly], roleManager)
        expect(text).toContain('`add`')
        expect(text).toContain('`list`')
        expect(text).not.toContain('noise')
    })

    it('沒有管理指令時不會出現管理指令標題', () => {
        const text = buildHelpText([open, adminOnly], () => false)
        expect(text).toContain('一般指令')
        expect(text).not.toContain('管理指令')
    })

    it('一個都看不到時給明確訊息', () => {
        expect(buildHelpText([adminOnly], () => false)).toBe('你目前沒有可以使用的指令。')
    })

    it('指令太多時截斷而不是讓 Discord 退件', () => {
        const many = Array.from({length: 200}, (unused, index) => ({
            name: `cmd_${index}`,
            description: '一段長度足夠把訊息撐爆的說明文字'.repeat(3),
        }))
        const text = buildHelpText(many, () => true)

        expect(text.length).toBeLessThanOrEqual(2000)
        expect(text).toContain('後面省略')
    })
})
