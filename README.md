# xccse · 学而思编程作品搜索引擎

针对 [code.xueersi.com](https://code.xueersi.com/)（学而思编程）公开作品区的搜索引擎：
自带爬虫、SQLite FTS5 索引和网页界面，支持中文精确子串检索、拼音检索与语言筛选。

**在线版：** https://objectivex666.github.io/xccse/

## 为什么要做这个

站点自带的搜索在当前线上版本里是**不可用**的（实测 2026-10）：

| 路径 | 结果 |
| --- | --- |
| `/search`、`/search-center` | 路由未注册，跳转 `/404` |
| `GET /api/search/hot_words` | `data: []` |
| `GET /api/works/search` | `400 Bad Request` |
| `GET /api/search` | `422 Unprocessable Entity` |

但作品的**数据接口是公开可用**的，所以完全可以自己在本地建一份索引来搜。

## 快速开始

```bash
npm install

npm run crawl          # 抓取公开作品数据（可反复运行，增量合并）
npm run index          # 构建 SQLite FTS5 索引
npm run serve          # 启动网页界面 http://127.0.0.1:8787
```

## GitHub Pages

线上版本是纯静态的：索引随页面一起下发，检索全部在浏览器内完成，不需要任何服务端。

```bash
npm run build:pages     # 由 data/works.jsonl 生成 docs/
npm run preview:pages   # 本地预览 http://127.0.0.1:8788
```

Pages 设置为 `main` 分支的 `/docs` 目录即可。`docs/data/works.json` 是唯一的数据文件，
首次访问约 1.2 MB（gzip 后更小），之后由浏览器缓存。3,053 条作品在浏览器里检索约 2ms。

静态版与 Node 版的检索语义一致：中文按真实子串匹配、英文按词前缀、纯字母查询会回退到
拼音（拼音串在构建时预先算好，浏览器不需要额外依赖）。

命令行检索：

```bash
node src/cli.mjs search 赛车
node src/cli.mjs search saiche            # 拼音
node src/cli.mjs search 贪吃蛇 --lang python
node src/cli.mjs search 游戏 --sort likes --limit 20
node src/cli.mjs stats
```

## 架构

```
src/http.mjs       HTTP 客户端：重试、限速、以及"读一半就断开"的详情流式抓取
src/crawl.mjs      爬虫：发现 → 沿作者 BFS 扩展 → 补全简介；增量合并写入
src/tokenize.mjs   分词：中文 bigram/单字 + 英文词 + 拼音
src/indexer.mjs    建索引：SQLite + FTS5（主检索表 + 拼音 trigram 表）
src/search.mjs     检索：BM25 + 热度加权，支持筛选/排序/分面
src/server.mjs     HTTP 服务：JSON API + 静态页面
web/               零依赖前端（原生 JS）
```

### 数据来源（全部为公开接口，无需登录）

| 接口 | 用途 |
| --- | --- |
| `/api/index/works/latest_popular` | 首页最新最热 |
| `/api/index/works/modules` | 首页栏目作品 |
| `/api/community/v4/recommend` | 社区推荐流（分页） |
| `/api/space/works?user_id=` | 按作者分页拉取作品 |
| `/api/space/profile?user_id=` | 作者资料 |
| `/api/projects/<id>` | 作品详情（简介 / 标签） |
| `/api/works/all_tags` | 标签体系 |

## 检索是怎么工作的

中文没有词间空格，FTS5 默认的 `unicode61` 分词器会把整句当成一个词，检索基本失效。
这里用**「相邻二元组 + 单字」双通道**解决：

- 建索引时，`会飞的赛车游戏` 切成 `会飞 飞的 的赛 赛车 车游 游戏`（另存单字通道）
- 检索时，`赛车游戏` 编译成 FTS5 短语 `"赛车 车游 游戏"`

短语要求词元**连续出现**，于是得到的是**真正的子串语义**——不是松散的关键词堆叠。
英文/数字按整词索引并支持前缀匹配（`pyth*`）。

拼音走一条独立的 FTS5 `trigram` 表，存作品的连续拼音串与声母串：

- `saiche` → 命中 `feixiangdesaiche`（飞翔的赛车）
- `fxds` → 命中声母串 `fxdsc`

主检索命中不足 5 条时自动回退到拼音检索，结果里会标注「拼音匹配」。

排序默认 `relevance`：`BM25 词法得分 + 0.30·ln(浏览) + 0.55·ln(点赞) + 0.20·ln(收藏)`，
标题列的权重远高于简介列（`t_bi=14` vs `b_bi=3`）。

## HTTP API

| 端点 | 说明 |
| --- | --- |
| `GET /api/search?q=&lang=&sort=&page=&limit=&author=` | 检索。`sort` ∈ `relevance\|views\|likes\|newest` |
| `GET /api/suggest?q=` | 标题联想 |
| `GET /api/stats` | 索引概览 |
| `GET /api/facets` | 语言 / 作者 / 标签分面 |
| `GET /api/work/:id` | 单条作品 |

## 抓取规模与礼貌性

- 默认 `--max-users 500` 沿作者维度 BFS；实测公开作品池收敛在约 80 位作者 / 3040 个作品。
- 并发默认 6，且每个请求之间有延迟；详情走**流式截断**，平均只下载几 KB 而不是整包 27KB+。
- 建议不要显著调高并发。数据仅用于检索，作品版权归原作者与学而思网校所有。

## 按作品 ID 扫描

用于补上「推荐流和作者页都没覆盖到」的公开作品。扫描是**分块、可断点续跑**的，
每次只跑一小段，进度写在 `data/scan-checkpoint.json`。

```bash
# 从某个 ID 起扫 100 次，目标 2 次/秒
npm run scan -- --from 34529 --max-requests 100 --rate 2

# 顺序测速：找出单线程能跑多快
npm run scan -- --from 34634 --probe --steps 1,2,4,8,16 --per-step 8

# 并发测速：找出吞吐上限（顺序请求会被单次延迟锁死）
npm run scan -- --from 34674 --probe-concurrency --steps 1,2,4,8,16 --per-step 10
```

产物：

| 文件 | 内容 |
| --- | --- |
| `data/scan-audit.jsonl` | 每个 ID 的状态、公开判定、字节数、延迟 |
| `data/scan-checkpoint.json` | 下一个待扫 ID，用于断点续跑 |
| `data/scan-works.jsonl` | 扫描到的公开作品，可再用 `index` 合入主索引 |

公开判定为 `published=1 && removed=0 && deleted_at="" && name` 非空；
其余记录只保留状态用于审计，不进入索引、也不保存其内容。

实测（2026-10，连续 ID 区间）：

- 顺序请求受单次延迟限制，约 **2.7 次/秒**；提高目标速率无效。
- 并发 16 时达到约 **24 次/秒**，无 429，p95 约 410ms；并发 32 反而略降，说明已到平台期。
- 单次详情平均下载 **7.2 KB**（源码 `xml` 排在 `published` 之前，无法提前截断）。

## 全量扫描：300 次跨年代抽样结论

用 4 个 ID 区间各 75 次请求抽样（`scripts/sample.mjs`）：

| 起始 ID | HTTP 200 | 公开作品 | 公开率 | 平均体积 |
| ---: | ---: | ---: | ---: | ---: |
| 5,000,000 | 59/75 | 23 | 30.7% | 77.4 KB |
| 20,000,000 | 75/75 | 1 | 1.3% | 23.5 KB |
| 40,000,000 | 0/75 | 0 | 0% | — |
| 60,000,000 | 0/75 | 0 | 0% | — |

边界探测补充：`30,000,000` 仍有记录，`33,000,000` 全部 404，**有效 ID 上界约 3,100 万**。

推论：

- **扫到 7,012 万是浪费**。40M 以上整段为空号，继续扫只增加请求量。
- 加权公开率 **8%**（Wilson 95% 区间约 5.4%–11.6%），对应约 **1.7M–3.6M 个公开作品**。
- 扫完 `1～31,000,000`：按 24 次/秒约 **15 天**，按 25.8 KB/次约 **800 GB** 流量。
- 作为对比：当前推荐流 + 作者 BFS 只用了数千次请求就拿到 3,053 个作品，**单位请求收益高两个数量级**。

结论：全 ID 扫描能覆盖 BFS 触达不到的作品，但应**只扫 3,100 万以内的稠密区间**，并且优先从公开率高的 ID 段（如 5M 附近）切入。

## 已知限制

- **只覆盖公开、免登录的内容。** 题库（`/api/tiku/*`）、codeUP 竞赛、课程学习中心需要登录，未纳入索引。
- 详情接口不返回可靠的作品分类标签，`tags` 多为空。
- 单个作品的简介是作者自愿填写的，缺简介的作品只能按标题/作者/语言检索。
- 索引结果上限 800 条命中（`SCAN_CAP`），用于保证响应时间。

## 常见命令

```bash
npm run crawl -- --max-users 200 --concurrency 4   # 限制抓取规模
npm run crawl -- --no-detail                       # 跳过简介补全，快很多
npm run serve -- --port 9000                       # 换端口
npm test                                           # 单元与集成测试

# 浏览器端到端验证（需先启动 serve，且本机装有 Chrome）
npm run verify:ui
```
