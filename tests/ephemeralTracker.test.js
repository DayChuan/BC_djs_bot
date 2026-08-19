import {describe, it, expect, beforeEach} from 'vitest'
import {refreshEphemeral, resetEphemeralTracker, trackEphemeral} from '@/core/ephemeralTracker'

//這個模組不碰 discord.js，只用假的 interaction 物件驗行為。
const makeInteraction = (id, {userId = 'U1', guildId = 'G1', fail = false} = {}) => ({
    id,
    guildId,
    user: {id: userId},
    deleted: 0,
    deleteReply: async function(){
        if(fail) throw Object.assign(new Error('Unknown Message'), {code: 10008})
        this.deleted += 1
    },
})

const MINUTE = 60 * 1000

describe('ephemeralTracker', () => {
    beforeEach(() => resetEphemeralTracker())

    it('第一次追蹤沒有前一則可刪', async() => {
        const first = makeInteraction('a')
        await trackEphemeral(first, 0)
        expect(first.deleted).toBe(0)
    })

    it('同一個人開第二則時會刪掉第一則', async() => {
        const first = makeInteraction('a')
        const second = makeInteraction('b')

        await trackEphemeral(first, 0)
        await trackEphemeral(second, MINUTE)

        expect(first.deleted).toBe(1)
        expect(second.deleted).toBe(0)
    })

    it('不同使用者互不影響', async() => {
        const mine = makeInteraction('a', {userId: 'U1'})
        const yours = makeInteraction('b', {userId: 'U2'})

        await trackEphemeral(mine, 0)
        await trackEphemeral(yours, MINUTE)

        expect(mine.deleted).toBe(0)
    })

    it('同一個人在不同伺服器互不影響', async() => {
        const here = makeInteraction('a', {guildId: 'G1'})
        const there = makeInteraction('b', {guildId: 'G2'})

        await trackEphemeral(here, 0)
        await trackEphemeral(there, MINUTE)

        expect(here.deleted).toBe(0)
    })

    it('超過 14 分鐘的舊回覆不再嘗試刪除(token 已失效)', async() => {
        const stale = makeInteraction('a')
        const fresh = makeInteraction('b')

        await trackEphemeral(stale, 0)
        await trackEphemeral(fresh, 15 * MINUTE)

        expect(stale.deleted).toBe(0)
    })

    it('刪除失敗不會往外拋', async() => {
        const first = makeInteraction('a', {fail: true})
        const second = makeInteraction('b')

        await trackEphemeral(first, 0)
        await expect(trackEphemeral(second, MINUTE)).resolves.toBeUndefined()
    })

    it('刪除失敗之後，新的那則仍然被記住', async() => {
        const first = makeInteraction('a', {fail: true})
        const second = makeInteraction('b')
        const third = makeInteraction('c')

        await trackEphemeral(first, 0)
        await trackEphemeral(second, MINUTE)
        await trackEphemeral(third, 2 * MINUTE)

        expect(second.deleted).toBe(1)
    })

    it('refresh 會把刪除期限接到新的 token 上', async() => {
        const opened = makeInteraction('a')
        const clicked = makeInteraction('b')
        const next = makeInteraction('c')

        await trackEphemeral(opened, 0)
        //10 分鐘後按了面板上的選單，就地更新 → 換成比較新的 token
        refreshEphemeral(clicked, 10 * MINUTE)
        //再過 10 分鐘開新面板：以 opened 來算早就過期，以 clicked 來算還在期限內
        await trackEphemeral(next, 20 * MINUTE)

        expect(clicked.deleted).toBe(1)
        expect(opened.deleted).toBe(0)
    })

    it('refresh 不會把沒被追蹤過的訊息納入管理', async() => {
        const stranger = makeInteraction('a')
        const mine = makeInteraction('b')

        refreshEphemeral(stranger, 0)
        await trackEphemeral(mine, MINUTE)

        expect(stranger.deleted).toBe(0)
    })
})
