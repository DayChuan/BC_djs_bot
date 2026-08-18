import{defineConfig} from 'vite'
import path from 'path'

export default defineConfig({
    resolve:{
        alias:{
            '@':path.resolve(__dirname,'./src'),
        }
    },
    test:{
        //測試環境是 FreeBSD jail，同時開多個 worker 會卡死：
        //先跑完的檔案正常，其餘停在 0/N 不動。換 pool(threads / forks)沒有差別，
        //只有把 worker 壓成一個(--no-file-parallelism)才跑得完，
        //所以問題在平行執行本身，不在 worker 的種類。
        //推測是 jail 內取到的 CPU 數是宿主機的，導致 vitest 開出遠超資源的 worker。
        //測試檔就五支、總共跑不到兩秒，循序執行沒有任何損失。
        fileParallelism:false,
        //discord.js 是很大的 CJS 套件。讓它走 Node 原生載入，
        //不要進 vite/esbuild 的轉換管線 —— 進去會卡在轉換階段永遠不回來
        //(症狀：有 import discord.js 的測試檔一跑就停住，CPU 全閒，
        // 連 --testTimeout 都管不到，因為測試根本還沒開始執行)。
        server:{deps:{external:['discord.js']}},
    }
})
