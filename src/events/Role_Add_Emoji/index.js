import {Events} from 'discord.js'
import {createRoleReactionHandler} from '@/core/roleGrant'

export const event = {
    name: Events.MessageReactionAdd
}

//emoji 與身分組的對照表在 src/config/environments/<環境>.js，
//新增一組身分組只要在那裡加一行，不需要動這個檔案。
export const action = createRoleReactionHandler('add')
