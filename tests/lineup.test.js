import {describe, it, expect} from 'vitest'
import {buildLineup, pickTopOptions} from '@/core/lineup'
import {FIRST_TEAM_IDENTITIES, rosterKey} from '@/config/lineup'

/**
 * 出團名單的分隊邏輯。這個單元的規則全部集中在 core/lineup.js，
 * 所以測試也集中在它身上。職業一律用職業表的 value 傳入，不用中文標籤。
 *
 * 這支測試不 import discord.js(也不 import 任何會碰到它的模組)，
 * 見 tests/moduleLayout.test.js 與 CLAUDE.md 的測試章節。
 */

//把 [userId, identity, level, name] 攤成 entries 與 roster 兩份輸入。
//level 給 null 代表這個人沒登記在人員表裡。
const build = (rows) => {
    const entries = rows.map(([userId, identity]) => ({userId, options: ['o0'], identity}))
    const roster = {}
    for(const [userId, identity, level, name] of rows){
        if(level === null) continue
        roster[rosterKey(userId, identity)] = {level, name: name || `角色${level}`}
    }
    return {entries, roster}
}

const lineupOf = (rows, options = {}) => {
    const {entries, roster} = build(rows)
    return buildLineup(entries, roster, options)
}

//一隊某一格的人名，沒人就回 null
const firstSeat = (lineup, identity) => {
    const seat = lineup.firstTeam.find((item) => item.identity === identity)
    return seat && seat.member ? seat.member.name : null
}

const names = (members) => members.map((member) => member.name)

describe('一隊的固定六職與順序', () => {
    //驗收 1
    it('六個固定職業各一人 → 一隊剛好六人，順序是箭神、夜使者、冰雷、火毒、黑騎士、聖騎士', () => {
        const lineup = lineupOf([
            ['u-paladin', 'paladin', 153, 'Cyyy'],
            ['u-dk', 'dark-knight', 157, '悠悠'],
            ['u-fire', 'fire', 160, '毛'],
            ['u-ice', 'ice', 164, 'ㄧㄅ'],
            ['u-nw', 'night-walker', 166, '肥熊'],
            ['u-bow', 'bowmaster', 173, '樸'],
        ])

        expect(lineup.firstTeam.map((seat) => seat.identity)).toEqual([
            'bowmaster', 'night-walker', 'ice', 'fire', 'dark-knight', 'paladin',
        ])
        //輸入刻意反著給，證明輸出順序來自 FIRST_TEAM_IDENTITIES 而不是輸入順序
        expect(names(lineup.firstTeam.map((seat) => seat.member)))
            .toEqual(['樸', '肥熊', 'ㄧㄅ', '毛', '悠悠', 'Cyyy'])
        expect(lineup.secondTeam).toEqual([])
        expect(lineup.reserves).toEqual([])
    })

    //驗收 2
    it('缺某個固定職業 → 該格是空的，其他人的位置不跑掉', () => {
        const lineup = lineupOf([
            ['u-bow', 'bowmaster', 173, '樸'],
            ['u-ice', 'ice', 164, 'ㄧㄅ'],
            ['u-dk', 'dark-knight', 157, '悠悠'],
        ])

        //六格都在，只是沒人的那格 member 為 null(排版時顯示 (缺人))
        expect(lineup.firstTeam).toHaveLength(FIRST_TEAM_IDENTITIES.length)
        expect(firstSeat(lineup, 'night-walker')).toBeNull()
        expect(firstSeat(lineup, 'fire')).toBeNull()
        expect(firstSeat(lineup, 'paladin')).toBeNull()
        //有人的三格還在它們原本的位置
        expect(firstSeat(lineup, 'bowmaster')).toBe('樸')
        expect(firstSeat(lineup, 'ice')).toBe('ㄧㄅ')
        expect(firstSeat(lineup, 'dark-knight')).toBe('悠悠')
    })
})

describe('同職業多人時誰進一隊', () => {
    /**
     * ⚠ 下面兩個案例是**刻意不對稱**的：冰雷取等級最高，黑騎士取等級最低。
     * 這是使用者 2026-09-03 確認的隊伍需求，不是筆誤。
     * 看到「規則不一致」時不要把兩邊改成一樣 —— 這兩個測試就是為了擋那件事。
     */

    //驗收 3
    it('兩個冰雷 → 等級**高**的進一隊，低的進二隊', () => {
        const lineup = lineupOf([
            ['u-ice-low', 'ice', 150, '低冰雷'],
            ['u-ice-high', 'ice', 164, '高冰雷'],
        ])

        expect(firstSeat(lineup, 'ice')).toBe('高冰雷')
        expect(names(lineup.secondTeam)).toEqual(['低冰雷'])
    })

    //驗收 4
    it('兩個黑騎士 → 等級**低**的進一隊，高的進二隊', () => {
        const lineup = lineupOf([
            ['u-dk-high', 'dark-knight', 169, '高黑騎'],
            ['u-dk-low', 'dark-knight', 156, '低黑騎'],
        ])

        expect(firstSeat(lineup, 'dark-knight')).toBe('低黑騎')
        expect(names(lineup.secondTeam)).toEqual(['高黑騎'])
    })

    //驗收 5
    it('三個火毒 → 一隊取最高，另外兩個進二隊(依等級由高到低)', () => {
        const lineup = lineupOf([
            ['u-fire-a', 'fire', 155, '火毒A'],
            ['u-fire-b', 'fire', 168, '火毒B'],
            ['u-fire-c', 'fire', 160, '火毒C'],
        ])

        expect(firstSeat(lineup, 'fire')).toBe('火毒B')
        expect(names(lineup.secondTeam)).toEqual(['火毒C', '火毒A'])
    })
})

describe('六職以外的職業與人數上限', () => {
    //驗收 6
    it('不在固定六職的職業(英雄、拳霸、刀賊…)全部進二隊', () => {
        const lineup = lineupOf([
            ['u-hero', 'hero', 157, '英雄'],
            ['u-cannon', 'cannon', 150, '拳霸'],
            ['u-shadower', 'shadower', 168, '刀賊'],
        ])

        expect(lineup.firstTeam.every((seat) => seat.member === null)).toBe(true)
        expect(names(lineup.secondTeam)).toEqual(['刀賊', '英雄', '拳霸'])
        expect(lineup.reserves).toEqual([])
    })

    //驗收 7
    it('13 人以上 → 第 13 人起進候補，候補不設上限', () => {
        //六個固定職各一人(進一隊) + 九個刀賊(二隊 6 個、候補 3 個)
        const fixed = FIRST_TEAM_IDENTITIES.map((identity, i) => [`u-${identity}`, identity, 200 + i, identity])
        const extra = Array.from({length: 9}, (_, i) => [`u-extra-${i}`, 'shadower', 190 - i, `多${i}`])
        const lineup = lineupOf([...fixed, ...extra])

        expect(lineup.firstTeam.filter((seat) => seat.member).length).toBe(6)
        expect(lineup.secondTeam).toHaveLength(6)
        //第 13 人起：等級 184、183、182 這三個
        expect(names(lineup.reserves)).toEqual(['多6', '多7', '多8'])
    })
})

describe('人員表查不到的人', () => {
    //驗收 8
    it('查不到 → 等級是 null(排版顯示 ??)，角色名退回顯示名稱，人不會消失', () => {
        const lineup = lineupOf(
            [
                ['u-bow', 'bowmaster', 173, '樸'],
                ['u-ghost', 'paladin', null],
            ],
            {displayNames: {'u-ghost': '沒登記的人'}},
        )

        const seat = lineup.firstTeam.find((item) => item.identity === 'paladin')
        expect(seat.member).not.toBeNull()
        expect(seat.member.level).toBeNull()
        expect(seat.member.name).toBe('沒登記的人')
    })

    it('等級未知的人排在有登記的人後面，不會擠掉他們', () => {
        const lineup = lineupOf(
            [
                ['u-ghost', 'shadower', null],
                ['u-known', 'hero', 140, '小英雄'],
            ],
            {displayNames: {'u-ghost': '幽靈'}},
        )

        expect(names(lineup.secondTeam)).toEqual(['小英雄', '幽靈'])
    })

    it('取等級最低的黑騎士時，沒登記的人不會被當成等級 0 而誤選進一隊', () => {
        const lineup = lineupOf(
            [
                ['u-ghost', 'dark-knight', null],
                ['u-known', 'dark-knight', 156, '有登記'],
            ],
            {displayNames: {'u-ghost': '幽靈'}},
        )

        expect(firstSeat(lineup, 'dark-knight')).toBe('有登記')
        expect(names(lineup.secondTeam)).toEqual(['幽靈'])
    })
})

describe('一人多角色', () => {
    it('同一個人的兩隻角色各自佔一個位置，等級各自獨立', () => {
        //使用者「424765737744334858」實際就是黑騎士 169 與聖騎士 171 兩隻
        const lineup = lineupOf([
            ['same-user', 'dark-knight', 169, '不是聖騎士'],
            ['same-user', 'paladin', 171, '不是黑騎士'],
        ])

        expect(firstSeat(lineup, 'dark-knight')).toBe('不是聖騎士')
        expect(firstSeat(lineup, 'paladin')).toBe('不是黑騎士')
    })
})

describe('pickTopOptions 取前兩高票', () => {
    const option = (key, label, count) => ({key, label, count})

    //驗收 9
    it('票數 5、5、3、1 → 取兩個層級共三個選項(兩個 5 票、一個 3 票)', () => {
        const picked = pickTopOptions([
            option('o0', '9/3', 5),
            option('o1', '9/4', 5),
            option('o2', '9/5', 3),
            option('o3', '9/6', 1),
        ])

        expect(picked.map((item) => item.label)).toEqual(['9/3', '9/4', '9/5'])
    })

    it('同票數之間維持選項原本的順序(＝日期的先後)', () => {
        const picked = pickTopOptions([
            option('o0', '9/5', 3),
            option('o1', '9/3', 5),
            option('o2', '9/4', 5),
        ])

        expect(picked.map((item) => item.label)).toEqual(['9/3', '9/4', '9/5'])
    })

    it('零票的選項不算一個層級', () => {
        const picked = pickTopOptions([
            option('o0', '9/3', 2),
            option('o1', '9/4', 0),
            option('o2', '9/5', 0),
        ])

        expect(picked.map((item) => item.label)).toEqual(['9/3'])
    })

    it('全部零票 → 不產生任何名單', () => {
        expect(pickTopOptions([{key: 'o0', label: '9/3', count: 0}])).toEqual([])
    })
})
