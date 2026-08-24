import {describe, it, expect} from 'vitest'
import {commandsHash} from '@/scripts/commandsHash'

/**
 * 部署腳本的雜湊護欄：內容沒變就跳過 REST，讓 yarn deploy 可以無腦每次都跑。
 * 護欄的正確性只有兩件事 —— 沒改就一定相同、有改就一定不同。
 *
 * commandsHash 是純函式(只用 node:crypto)，不會間接碰到 discord.js，
 * 所以可以在測試 jail 裡跑；collectCommands 會 import 指令檔、間接吃到
 * discord.js，測試不能碰，那一段一律在測試伺服器實機驗收。
 */

const INPUT = {
    applicationId: '111',
    guildIds: ['222', '333'],
    commands: [
        {name: 'poll', description: '投票'},
        {name: 'help', description: '說明'},
    ],
}

describe('commandsHash', () => {
    it('同一份內容兩次呼叫結果相同', () => {
        expect(commandsHash(INPUT)).toBe(commandsHash(INPUT))
    })

    it('改動指令名稱後結果不同', () => {
        const changed = {
            ...INPUT,
            commands: [{name: 'poll2', description: '投票'}, INPUT.commands[1]],
        }
        expect(commandsHash(changed)).not.toBe(commandsHash(INPUT))
    })

    it('改動指令描述後結果不同', () => {
        const changed = {
            ...INPUT,
            commands: [{name: 'poll', description: '投票(改)'}, INPUT.commands[1]],
        }
        expect(commandsHash(changed)).not.toBe(commandsHash(INPUT))
    })

    it('新增伺服器後結果不同', () => {
        //只算指令內容的話這裡會相同，新伺服器就永遠註冊不到指令。
        const changed = {...INPUT, guildIds: ['222', '333', '444']}
        expect(commandsHash(changed)).not.toBe(commandsHash(INPUT))
    })

    it('伺服器順序不影響結果', () => {
        const reordered = {...INPUT, guildIds: ['333', '222']}
        expect(commandsHash(reordered)).toBe(commandsHash(INPUT))
    })

    it('applicationId 不同結果就不同', () => {
        expect(commandsHash({...INPUT, applicationId: '999'})).not.toBe(commandsHash(INPUT))
    })
})
