// Card Walk（刷卡）：从库里抽 #card 卡片和 ==挖空==，在侧栏一张张刷——先看问题，揭开，按「重来 / 困难 / 良好 / 简单」作答
//   · 排程走 Anki（AnkiConnect 的 answerCards）；卡片 ↔ Anki 笔记的对应读 Flashcards 插件写在笔记属性 flashcards 里的「块 id → nid」
//   · 手机上也能刷：作答经 Upstash Redis 中转，电脑几秒内写进 Anki；两边面板顶上一条同步状态，每次作答「已记 → 已到中转 → 已进 Anki」三步看得见
//   · 2026-10-29 从「第二大脑」拆出来，按以后上架社区插件的标准写：中英文界面，不用 Node，默认值不带作者自己的东西。设计见仓库里的 DESIGN.md
const obsidian = require("obsidian");
const { Plugin, ItemView, Notice, Menu, MarkdownRenderer, PluginSettingTab, Setting, Keymap, Scope, requestUrl, Platform, moment } = obsidian;
const { EditorView } = require("@codemirror/view");

const MOBILE = !!Platform?.isMobile;
const VIEW = "card-walk";
const SB_ID = "second-brain-local";   // 作者自己的「第二大脑」：装了就借它的向量按意思归学科（任何提供 embedCached(texts) 的插件都行）

const DEFAULTS = {
    journalFolder: "",        // 空 = 跟着核心插件「日记」的文件夹和日期格式
    excludeFolders: "",       // 不抽这些文件夹 / 文件里的卡（逗号分隔）
    privateLinks: "",         // 带这些双链的块不抽（逗号分隔）
    reviewCount: 5,           // 面板上同时摆几张
    reviewGoal: 20,           // 每天的目标张数（一张卡第一次揭开或作答时 +1）
    recentBoost: 1,           // 近一年的卡被抽到的权重倍数（1 = 不偏向）
    boostLinks: "",           // 卡片本身或上层母块链到这些页的，权重再乘 linkBoost（逗号分隔，不分大小写）
    linkBoost: 3,
    subjects: "",             // 学科：一行一门，「名称：双链, 双链 | 文件夹, 文件夹」
    langPattern: "",          // 语言类：卡片本身、上层或下层链到名字符合这个正则的页（如 ^.{1,4}[语文](记录|表达)$）
    langExcept: "",           // 但这些页不算（逗号分隔）
    langGuess: false,         // 没挂这类双链、但挖掉的全是外文生词 / 英文句子的挖空也算语言类
    knowledgeFolders: "",     // 链到这些文件夹里的页（知识概念页）的挖空不按外文猜成语言类（逗号分隔）
    ankiReview: true,         // 揭开后能作答，写进 Anki
    ankiUrl: "http://127.0.0.1:8765",
    durationCheck: false,     // 作答后核对用时有没有记进 Anki（新版 AnkiConnect 直接认；老版要打补丁）
    ankiAutoSync: false,      // 答完让 Anki 同步到 AnkiWeb（最后一次作答 3 分钟后一次）
    reviewLog: false,         // 一轮复习的时间和张数记进今天日记顶部（属性区后面第一行）
    reviewLogTemplate: "",    // 那一行的格式；空 = 按界面语言的默认格式
    fxSound: true,
    fxAnim: true,
    fxVolume: 55,
    autoOpen: false,          // 每天第一次打开 Obsidian 时在右侧栏放一个刷卡标签（不抢焦点）
    relayUrl: "",             // Upstash Redis 的 REST 地址（https://xxx.upstash.io）
    relayToken: "",           // Upstash Redis 的 REST token
};

// ---------- 界面文字 ----------
const STR = {
    zh: {
        viewTitle: "刷卡", open: "打开刷卡", syncNow: "立刻同步", head: "🃏 刷卡 · {date}",
        focusTip: "聚焦：只看一张（⌥⌘→ 进，⌥⌘← 或 Esc 出）", againTip: "重新抽", noFocus: "没有可以聚焦的卡片",
        backTip: "往回看答过的卡，可以一直往回（在最上面一张按 ↑ 也行）", noPrev: "没有更早答过的卡了", prevTag: " · ↶ 倒数第 {n} 张",
        crumbTip: "点一下展开到这一层，⌘ 点打开原文", fold: "收起", ctxStale: "原文改过了，展开不了：点 ↻ 重新抽",
        pauseTip: "暂停计时：这一轮先记进日记，回来另起一行", resumeTip: "继续计时",
        goal: "今天 {done} / {goal} 张", goalMet: "✓ 今天 {done} / {goal} 张", dayTip: "{d} · {n} 张",
        streak: "连续 {n} 天", streak0: "今天开个头", left: "这一批还剩 {n} 张",
        finishMet: "今天的 {goal} 张刷完了", finish: "这一批刷完了",
        finishMetHint: "可以收工了。点「重来」的卡 Anki 会在之后再排给你", finishHint: "符合当前范围的卡抽完了，换个范围或类别试试",
        more10: "再来 10 张", walk: "🎲 随机漫步", counts: "卡片 {c} · 挖空 {z}", dueN: " · 今天到期 {n}",
        tabMain: "知识", tabLang: "语言", all: "全部", other: "其他", r7: "7 天", r30: "1 个月", rAll: "全部",
        emptyAll: "没有可抽的卡片或挖空", emptyRange: "最近 {n} 天没有新增的卡片或挖空", emptyLang: "没有语言类的卡片或挖空", emptySubj: "「{s}」下没有卡片或挖空",
        kCard: "🃏 卡片", kCloze: "✂️ 挖空", again: " · 🔁 再想一次", reveal: "👁 揭开",
        uncardCard: "不再作为卡片（去掉 #card）", uncardCloze: "不再作为卡片（去掉挖空）", openSrc: "打开原文",
        notInAnki: "没同步到 Anki", noAnkiCard: "Anki 里没这张卡", ankiDown: "Anki 没开 ", retry: "重试",
        suspended: "已暂停", buried: "已搁置", isNew: "新卡", dueToday: "今天到期", learning: "学习中", inDays: "{n} 天后", interval: "间隔 {n} 天",
        noSnap: "还没收到电脑上的 Anki 进度", noRelay: "没开同步，手机上只能看，不能作答", answeredHere: "✓ 这台设备上答过了",
        answeredOn: "已在 {dev} 上答过", queuedPhone: "{dev} 上答过了，等着补进 Anki", notDue: "还没到期", changedElsewhere: "进度刚更新：已经在别处答过",
        ease1: "重来", ease2: "困难", ease3: "良好", ease4: "简单",
        nextDays: "✓ {n} 天后", soon: "✓ 一会儿再来", saved: "✓ 记下了", savedUp: "✓ 已到中转站 · 电脑会写进 Anki", savedLocal: "✓ 存在本机 · 联网后上传",
        durWarn: " · ⚠️ 用时没记进 Anki", notRecorded: "没记进 Anki：{e}", rejected: "Anki 没接受这次作答",
        goalDone: "今天的 {goal} 张刷完了 🎉",
        noMark: "这一块里没找到 #card 或挖空标记", changed: "原文已经改过了，没动。刷新一下再试", uncarded: "「{f}」这一块已不再是卡片 ", undo: "撤销", undone: "已撤销", cantUndo: "原文又改过了，没法撤销",
        logFail: "复习计时没记进日记：{e}", logTpl: "DONE {start}-{end} 复习卡片 {n} 张（{detail}）", logAns: "作答 {n}", logAgain: "重来 {n}", logLook: "只看 {n}",
        ankiSyncFail: "Anki 同步没成功：{e}。复习记录已经在本机 Anki 里了，下次同步会带上",
        // 同步状态
        justNow: "刚刚", sAgo: "{n} 秒前", mAgo: "{n} 分钟前", hAgo: "{n} 小时前", dAgo: "{n} 天前",
        offD: "手机同步没开 · 设置里填上 Upstash 就能在手机上刷", offM: "没开同步 · 在设置里填上和电脑一样的 Upstash 地址和 token 才能作答",
        err: "连不上中转站：{e}", errLocal: " · {n} 张存在本机，联网后自动传", connecting: "正在连中转站…",
        dPhone: "📱 {dev} {ago}在刷", dFromPhone: "今天从手机补进 Anki {n} 张", dIdle: "中转站正常 · 进度 {ago}核对过", dNoPhone: " · 手机 {ago}来过",
        dAnkiDown: "Anki 没开 · 手机上的作答等 Anki 开了再补", dWaiting: " · {n} 张等着补",
        mLive: "电脑在线 · Anki 开着 · 进度 {ago}对齐", mNoAnki: "电脑在线，但 Anki 没开 · 作答先排队", mOffline: "电脑 {ago}下线 · 用的是那时的进度", mNever: "还没有电脑连上中转站",
        mToday: "今天在这台设备上答 {n} 张：已进 Anki {a} · 等电脑 {w}", mLocal: " · 没上传 {n}", mRejected: " · Anki 不收 {n}",
        hintOffline: "电脑关着就没人改 Anki，进度仍然准；这里答的先排队，电脑上线后补进去", hintNoAnki: "Anki 一开，排队的作答会自动补进去",
        devices: "设备", recent: "最近的作答", none: "今天还没有", stSaved: "已记", stUp: "中转", stAnki: "Anki", thisDev: "（这台）",
        rejectedAs: "Anki 不收：{e}", ivl: "{n} 天后", ivl0: "一会儿再来", ankiOn: "Anki 开着", ankiOff: "Anki 没开",
        cardDeleted: "Anki 没接受（卡可能删了）",
        // 设置
        sCards: "抽卡", sJournal: "日记文件夹", sJournalD: "留空 = 跟着核心插件「日记」的文件夹和日期格式。日记里的卡按日记日期算新增时间，别的笔记按文件建立时间",
        sExclude: "不参与的文件夹 / 文件", sExcludeD: "逗号分隔", sPrivate: "私密链接", sPrivateD: "带这些双链的块不抽（逗号分隔）",
        sCount: "同时摆几张", sGoal: "每天的目标（张）", sAutoOpen: "每天自动放一个刷卡标签", sAutoOpenD: "每天第一次打开 Obsidian 时在右侧栏加一个标签（不抢焦点）",
        sWeight: "抽卡权重", sRecent: "近一年的卡更容易抽到", sRecentD: "近一年新增的卡被抽到的权重是更早那些的几倍；1 = 不偏向",
        sBoost: "这些双链的卡更容易抽到", sBoostD: "卡片本身或上层母块链到这些页（逗号分隔，不分大小写），权重乘下面的倍数", sBoostN: "上面这些双链的倍数", sBoostND: "1 = 不偏向",
        sSubjects: "学科", sSubjectsD: "一行一门：「名称：双链, 双链 | 文件夹, 文件夹」。卡片本身或上层母块链到这些页、或在这些文件夹里，就归这门（从上往下第一个对上的）。都没对上的：装了第二大脑就按意思归到最像的一门，否则算「其他」",
        sSuggest: "从卡片里推荐学科", sSuggestD: "看卡片本身和母块里链到的页、卡片所在的文件夹，挑出能把卡分得最开的几个，加到上面的学科里（已经归了类的卡不再算）。加完可以改名、合并或删掉", sSuggestB: "推荐",
        suggestNone: "没找到够多卡片共用的双链或文件夹", suggestAdded: "加了 {n} 门学科，在设置里可以改名、合并或删掉",
        sLang: "语言类", sLangP: "语言类双链（正则）", sLangPD: "卡片本身、上层或下层链到名字符合它的页就算语言类，单独一个「语言」分类。留空 = 不分语言类。例：^.{1,4}[语文](记录|表达)$",
        sLangE: "不算语言类的页", sLangED: "逗号分隔", sLangG: "没挂双链的外文挖空也算语言类", sLangGD: "挖掉的全是英文生词 / 日文、或整句是英文句子的挖空",
        sKnow: "知识概念文件夹", sKnowD: "链到这些文件夹里的页的挖空，不按外文猜成语言类（逗号分隔）",
        sAnki: "Anki", sAnkiR: "作答写进 Anki", sAnkiRD: "揭开后可以按「重来 / 困难 / 良好 / 简单」作答，直接写进 Anki 的复习记录（电脑上要 Anki 开着、装了 AnkiConnect）。没到期的卡只能看。每张的用时按真实时间记：从上一次操作算到这次，暂停的不算，一张最多 60 秒（新版 AnkiConnect 直接认；老版不认，要打补丁）",
        sAnkiUrl: "AnkiConnect 地址",
        sDurChk: "核对用时有没有记上", sDurChkD: "作答后查一下这次的用时进没进 Anki，没进就在卡片上提示。新版 AnkiConnect（有 /api/v1 接口）直接认用时；老版要打补丁（answerCards 里 card.timer_started -= duration），自动更新后补丁会丢",
        sAutoSync: "答完同步 AnkiWeb", sAutoSyncD: "最后一次作答 3 分钟后（或关掉刷卡面板时）让 Anki 同步一次。要在 Anki 里登录过 AnkiWeb",
        sLog: "复习计时记进日记", sLogD: "一轮复习（最后一次操作 3 分钟后，或关掉面板时算结束）在今天日记属性区后面插一行；10 分钟内接着复习就延长那一行。用时是这一轮每张卡的真实用时加起来。中途要走开就点面板顶上的 ⏸：表停，这一轮当场记一行，回来另起一行",
        sLogTpl: "那一行的格式", sLogTplD: "可用 {start} {end} {n} {detail}。留空 = 「{tpl}」",
        sSync: "手机同步（Upstash）", sSyncD: "手机上答的卡经 Upstash Redis 中转，电脑几秒内写进 Anki。每台设备都填同一个库。上传的只有卡号、作答等级、时间、设备名和 Anki 进度快照（卡号列表），不传卡片内容。",
        sRelayUrl: "REST 地址", sRelayUrlD: "Upstash 控制台里 REST API 一栏的 URL（https://…upstash.io）", sRelayTok: "REST token", sRelayTokD: "同一栏的 token（不是只读的那个）",
        sDevName: "这台设备的名字", sDevNameD: "同步状态里显示，只存在这台设备上", sTest: "测试连接", sTestOk: "连上了（{ms} 毫秒）", sTestFail: "连不上：{e}",
        sFx: "作答反馈", sSound: "提示音", sSoundD: "答对一小段往上走的音，答错往下走；揭开、去掉卡片也各有一声。Web Audio 现场合成", sAnim: "小烟花", sAnimD: "在作答按钮那儿炸一小簇：答对往上散，答错往下落",
        sVol: "音量", sVolD: "0 = 静音", sTry: "试听",
    },
    en: {
        viewTitle: "Card Walk", open: "Open Card Walk", syncNow: "Sync now", head: "🃏 Card Walk · {date}",
        focusTip: "Focus on one card (⌥⌘→ in, ⌥⌘← or Esc out)", againTip: "Draw again", noFocus: "No card to focus",
        backTip: "Look back at answered cards, one by one (or ↑ on the top card)", noPrev: "No earlier answered cards", prevTag: " · ↶ {n} back",
        crumbTip: "Click to expand to this level, ⌘-click to open the note", fold: "Collapse", ctxStale: "The note has changed and can't be expanded: press ↻ to draw again",
        pauseTip: "Pause the timer: log this session now, start a new one when you're back", resumeTip: "Resume the timer",
        goal: "Today {done} / {goal}", goalMet: "✓ Today {done} / {goal}", dayTip: "{d} · {n} cards",
        streak: "{n}-day streak", streak0: "Start your streak today", left: "{n} left in this batch",
        finishMet: "Today's {goal} cards are done", finish: "This batch is done",
        finishMetHint: "You can stop here. Anki will bring back the cards you marked Again.", finishHint: "No more cards in this range. Try another range or category.",
        more10: "10 more", walk: "🎲 Random walk", counts: "Cards {c} · Clozes {z}", dueN: " · {n} due today",
        tabMain: "Knowledge", tabLang: "Language", all: "All", other: "Other", r7: "7 days", r30: "1 month", rAll: "All",
        emptyAll: "No cards or clozes to draw", emptyRange: "No cards or clozes added in the last {n} days", emptyLang: "No language cards or clozes", emptySubj: "No cards or clozes in “{s}”",
        kCard: "🃏 Card", kCloze: "✂️ Cloze", again: " · 🔁 One more time", reveal: "👁 Reveal",
        uncardCard: "Stop using as a card (remove #card)", uncardCloze: "Stop using as a card (remove cloze marks)", openSrc: "Open source note",
        notInAnki: "Not in Anki yet", noAnkiCard: "Not found in Anki", ankiDown: "Anki is not running ", retry: "Retry",
        suspended: "Suspended", buried: "Buried", isNew: "New", dueToday: "Due today", learning: "Learning", inDays: "Due in {n} days", interval: "Interval {n} days",
        noSnap: "No Anki progress from a computer yet", noRelay: "Sync is off: you can read cards here but not answer them", answeredHere: "✓ Answered on this device",
        answeredOn: "Already answered on {dev}", queuedPhone: "Answered on {dev}, waiting to go into Anki", notDue: "Not due yet", changedElsewhere: "Progress just updated: already answered elsewhere",
        ease1: "Again", ease2: "Hard", ease3: "Good", ease4: "Easy",
        nextDays: "✓ Next in {n} days", soon: "✓ Back soon", saved: "✓ Saved", savedUp: "✓ Uploaded · your computer will add it to Anki", savedLocal: "✓ Saved here · will upload when online",
        durWarn: " · ⚠️ Review time not recorded in Anki", notRecorded: "Not recorded in Anki: {e}", rejected: "Anki did not accept the answer",
        goalDone: "Today's {goal} cards are done 🎉",
        noMark: "No #card or cloze marks in this block", changed: "The note has changed since it was loaded. Refresh and try again.", uncarded: "This block in “{f}” is no longer a card ", undo: "Undo", undone: "Undone", cantUndo: "The note changed again, can't undo",
        logFail: "Couldn't log the review session: {e}", logTpl: "DONE {start}-{end} Reviewed {n} cards ({detail})", logAns: "answered {n}", logAgain: "again {n}", logLook: "viewed {n}",
        ankiSyncFail: "Anki sync failed: {e}. Your reviews are saved in Anki and will go up with the next sync.",
        justNow: "just now", sAgo: "{n}s ago", mAgo: "{n} min ago", hAgo: "{n} h ago", dAgo: "{n} d ago",
        offD: "Phone sync is off · add an Upstash database in settings to review on your phone", offM: "Sync is off · enter the same Upstash URL and token as on your computer to answer cards",
        err: "Can't reach the sync server: {e}", errLocal: " · {n} answers saved here, they'll upload when online", connecting: "Connecting…",
        dPhone: "📱 {dev} active {ago}", dFromPhone: "{n} phone answers added to Anki today", dIdle: "Sync OK · progress checked {ago}", dNoPhone: " · phone seen {ago}",
        dAnkiDown: "Anki isn't running · phone answers will be added when it starts", dWaiting: " · {n} waiting",
        mLive: "Computer online · Anki running · progress synced {ago}", mNoAnki: "Computer online, Anki not running · answers are queued", mOffline: "Computer offline since {ago} · using its last progress", mNever: "No computer has connected yet",
        mToday: "Answered here today: {n} · in Anki {a} · waiting {w}", mLocal: " · not uploaded {n}", mRejected: " · rejected {n}",
        hintOffline: "Nobody changes Anki while the computer is off, so this progress is still current. Answers here wait until it's back.", hintNoAnki: "Queued answers go into Anki as soon as it starts.",
        devices: "Devices", recent: "Recent answers", none: "None today", stSaved: "Saved", stUp: "Uploaded", stAnki: "Anki", thisDev: " (this one)",
        rejectedAs: "Rejected by Anki: {e}", ivl: "in {n} d", ivl0: "back soon", ankiOn: "Anki running", ankiOff: "Anki not running",
        cardDeleted: "Anki did not accept it (card deleted?)",
        sCards: "Drawing cards", sJournal: "Journal folder", sJournalD: "Leave empty to follow the core Daily notes folder and date format. Cards in journals are dated by the journal date, others by file creation time.",
        sExclude: "Excluded folders / files", sExcludeD: "Comma separated", sPrivate: "Private links", sPrivateD: "Blocks containing these links are never drawn (comma separated)",
        sCount: "Cards shown at once", sGoal: "Daily goal (cards)", sAutoOpen: "Open a Card Walk tab every day", sAutoOpenD: "The first time you open Obsidian each day, add a tab to the right sidebar without taking focus",
        sWeight: "Weighting", sRecent: "Favor cards from the last year", sRecentD: "Cards added in the last year are this many times more likely to be drawn; 1 = no preference",
        sBoost: "Favor cards linking to", sBoostD: "Cards whose block or parent blocks link to these pages (comma separated, case-insensitive) get the multiplier below", sBoostN: "Multiplier for those links", sBoostND: "1 = no preference",
        sSubjects: "Subjects", sSubjectsD: "One per line: “Name: link, link | folder, folder”. A card belongs to the first subject whose links appear in it or its parent blocks, or whose folders contain it. Others go to “Other”, or, if Second Brain is installed, to the most similar subject by meaning.",
        sSuggest: "Suggest subjects from your cards", sSuggestD: "Looks at the pages your cards and their parent blocks link to and the folders they're in, and picks the few that split your cards best (cards already in a subject don't count). They're added above; rename, merge or delete them as you like.", sSuggestB: "Suggest",
        suggestNone: "No links or folders are shared by enough cards", suggestAdded: "Added {n} subjects; rename, merge or delete them in settings",
        sLang: "Language cards", sLangP: "Language link pattern (regex)", sLangPD: "Cards linking (in the block or its parents/children) to a page whose name matches go to a separate “Language” tab. Leave empty to turn this off.",
        sLangE: "Pages that don't count", sLangED: "Comma separated", sLangG: "Guess foreign-word clozes", sLangGD: "Clozes that hide only English or Japanese words, or whole English sentences, count as language cards even without links",
        sKnow: "Concept folders", sKnowD: "Clozes linking to pages in these folders are never guessed as language cards (comma separated)",
        sAnki: "Anki", sAnkiR: "Answer into Anki", sAnkiRD: "After revealing, answer Again / Hard / Good / Easy and the review goes straight into Anki (on a computer, Anki must be running with AnkiConnect). Cards that aren't due can only be read. Each review records the real time spent, from the previous action to this one, excluding pauses, at most 60 seconds per card (newer AnkiConnect takes it directly; older versions ignore it unless patched).",
        sAnkiUrl: "AnkiConnect URL",
        sDurChk: "Check the review time", sDurChkD: "After answering, check that the review time reached Anki and warn on the card if it didn't. Newer AnkiConnect (with the /api/v1 interface) takes the time directly; older versions need a patch (card.timer_started -= duration in answerCards), which updates remove",
        sAutoSync: "Sync AnkiWeb after answering", sAutoSyncD: "Ask Anki to sync 3 minutes after the last answer (or when the panel is closed). Requires an AnkiWeb login in Anki.",
        sLog: "Log review sessions in the journal", sLogD: "Each session (ends 3 minutes after the last action or when the panel closes) adds a line after today's properties; reviewing again within 10 minutes extends it. The time is the real time spent on each card, added up. Stepping away? Press ⏸ at the top of the panel: the timer stops, the session is logged now and a new line starts when you're back.",
        sLogTpl: "Log line format", sLogTplD: "Use {start} {end} {n} {detail}. Empty = “{tpl}”",
        sSync: "Phone sync (Upstash)", sSyncD: "Answers made on your phone go through an Upstash Redis database and reach Anki on your computer within seconds. Use the same database on every device. Only card IDs, ratings, times, device names and an Anki progress snapshot (card IDs) are uploaded, never card content.",
        sRelayUrl: "REST URL", sRelayUrlD: "The REST API URL from the Upstash console (https://…upstash.io)", sRelayTok: "REST token", sRelayTokD: "The token from the same section (not the read-only one)",
        sDevName: "This device's name", sDevNameD: "Shown in the sync status; stored on this device only", sTest: "Test connection", sTestOk: "Connected ({ms} ms)", sTestFail: "Failed: {e}",
        sFx: "Feedback", sSound: "Sounds", sSoundD: "A rising chime for Good / Easy, a falling one for Again / Hard, plus small sounds for reveal and remove. Synthesized with Web Audio.", sAnim: "Sparks", sAnimD: "A small burst at the answer button: up for right, down for wrong",
        sVol: "Volume", sVolD: "0 = mute", sTry: "Preview",
    },
};
// 界面语言跟着 Obsidian：新版有 getLanguage()，旧版看 moment 的语言
const LANG = () => String(obsidian.getLanguage?.() || moment.locale() || "en").startsWith("zh") ? "zh" : "en";
const t = (k, vars) => { const s = STR[LANG()][k] ?? STR.en[k] ?? k; return vars ? s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] ?? m)) : s; };
// 多久以前：刚刚 / 12 秒前 / 3 分钟前 …
function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return t("justNow");
    if (s < 60) return t("sAgo", { n: s });
    if (s < 3600) return t("mAgo", { n: Math.round(s / 60) });
    if (s < 86400) return t("hAgo", { n: Math.round(s / 3600) });
    return t("dAgo", { n: Math.round(s / 86400) });
}

// ---------- 小工具 ----------
const M = () => moment();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WALK_RANGES = [["7d", "r7", 7], ["30d", "r30", 30], ["all", "rAll", 0]];
// 不依赖 Node 的短哈希（FNV-1a），手机和电脑算出来一样
function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
const split = (v) => String(v || "").split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
// 学科设置 → [{ name, links: Set(小写), folders: [] }]
function parseSubjects(text) {
    return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^([^：:]+)[：:](.*)$/);
        if (!m) return null;
        const [links, folders] = m[2].split("|");
        return { name: m[1].trim(), links: new Set(split(links).map((x) => x.toLowerCase())), folders: split(folders).map((x) => x.replace(/\/$/, "")) };
    }).filter(Boolean);
}
// 可复现的随机数：同一天同一个种子，抽到的东西一样（刷新不变，点「重新抽」才变）
function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
// 加权打乱：权重大的更容易排到前面（每项取 rand^(1/w) 从大到小排，等于按权重不放回地抽）
function weightedShuffle(arr, rand, weight) {
    return arr.map((x) => [Math.pow(rand(), 1 / Math.max(weight(x), 1e-6)), x]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}
// 显示用：去掉列表前缀、块 ID、双链语法
function plain(s) {
    return String(s)
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
        .replace(/\s\^[\w-]+\s*$/gm, "")
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/==|\*\*|__/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
// 挖空：和 Flashcards 一样编号（{{c2::…}}、{2:…} 用自己的号，==…== 按出现顺序 1、2、3…）；target = 要遮的那个号，null = 全遮
function clozeMask(text, target) {
    let auto = 0;
    return String(text).replace(/\{\{c(\d+)::([\s\S]*?)\}\}|\{(\d+):([^{}\n]*?)\}|==([^=\n]+)==/g, (m, n1, b1, n2, b2, b3) => {
        const num = n1 ? +n1 : n2 ? +n2 : ++auto;
        const body = b1 ?? b2 ?? b3;
        return target === null || num === target ? "［⋯］" : body;
    });
}
const cardText = (s) => String(s).replace(/\s*#(card|flashcard|reversed)\b/gi, "");
// 渲染用的 Markdown：去掉制卡标签、块 id、单独一行的 ^q-xxxx，整体去掉公共缩进（嵌套的卡不会被当成代码块）
function cardMd(text) {
    const L = cardText(text).split("\n").filter((l) => !/^\s*\^[\w-]+\s*$/.test(l)).map((l) => l.replace(/\s\^[\w-]+\s*$/, ""));
    const ind = Math.min(...L.filter((l) => l.trim()).map((l) => (l.match(/^[\t ]*/) || [""])[0].replace(/ {4}/g, "\t").length));
    return L.map((l) => l.replace(/ {4}/g, "\t").replace(new RegExp(`^\\t{0,${Number.isFinite(ind) ? ind : 0}}`), "")).join("\n").trim();
}
// 揭开后的挖空：{{c1::x}}、{1:x} 都显示成高亮
const clozeReveal = (s) => String(s).replace(/\{\{c\d+::([\s\S]*?)\}\}/g, "==$1==").replace(/\{(\d+):([^{}\n]*?)\}/g, "==$2==");
// 每个列表项连同子项到哪一行：起始行 → 子树最后一行
function listEnds(items) {
    const endOf = new Map();
    // 「- 2. 正文」这种写法在同一行起两个列表项（外层无序、里层有序），取更大的结束行，免得里层把外层下面的表格截掉
    for (const it of items) { const s = it.position.start.line; endOf.set(s, Math.max(endOf.get(s) ?? -1, it.position.end.line)); }
    for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i], p = it.parent;
        if (p >= 0 && endOf.has(p)) endOf.set(p, Math.max(endOf.get(p), endOf.get(it.position.start.line)));
    }
    return endOf;
}
// 展开到某一层母块（和 Roam 反链一样）：从第 s 行到第 e 行这一整块，卡片本身那几行换成 own（现在该显示的样子），去掉公共缩进。
// 卡片第一行末尾带一个记号（私用区字符），渲染完靠它找到卡片那一项（MarkdownRenderer 不给列表项标行号）
const SELF_MARK = "\uE000";
function ctxMd(L, s, e, it, own) {
    const indent = (l) => (l.match(/^[\t ]*/) || [""])[0];
    const base = indent(L[s]), out = [];
    for (let k = s; k <= e; k++) {
        if (k === it.line) {
            const ind = indent(L[k]).slice(base.length);
            own.split("\n").forEach((l, i) => out.push(l && ind + l + (i ? "" : SELF_MARK)));
            k = it.end;
            continue;
        }
        if (/^\s*\^[\w-]+\s*$/.test(L[k])) continue;
        const l = L[k].startsWith(base) ? L[k].slice(base.length) : L[k].trimStart();
        out.push(clozeReveal(cardText(l)).replace(/\s\^[\w-]+\s*$/, ""));
    }
    return out.join("\n");
}
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

// ---------- 跳到某一行：稳定地停在视口正中，并选中这一行的文字（和第二大脑、Hover Outline 同一份） ----------
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const LINE_PREFIX_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[.\]\s+)?(?:#{1,6}\s+)?/;
async function centerOn(sc, measure) {
    for (let i = 0; i < 10; i++) {
        await nextFrame();
        await nextFrame();
        const m = measure();
        if (!m) return;
        const s = sc.getBoundingClientRect();
        const delta = m.top + m.height / 2 - (s.top + s.height / 2);
        if (Math.abs(delta) < 2) return;
        const before = sc.scrollTop;
        sc.scrollTop = before + delta;
        if (Math.abs(sc.scrollTop - before) < 1) return;   // 到顶 / 到底了
    }
}
function previewElAt(renderer, line) {
    const sec = (renderer.sections || []).find((s) => s.start && s.end && s.lines !== 0 && s.start.line <= line && line <= s.end.line);
    if (!sec || !sec.el || !sec.el.isConnected || !sec.el.firstElementChild) return null;
    const lis = sec.el.querySelectorAll(`li[data-line="${line - sec.start.line}"]`);
    return lis.length ? lis[lis.length - 1] : sec.el.firstElementChild;
}
function ownRange(el) {
    const range = document.createRange();
    if (el.tagName === "LI") {
        range.setStart(el, 0);
        const sub = [...el.children].find((c) => /^(UL|OL)$/.test(c.tagName) || c.classList.contains("list-children"));
        if (sub) range.setEndBefore(sub);
        else range.setEnd(el, el.childNodes.length);
    } else range.selectNodeContents(el);
    return range;
}
async function revealLine(view, line) {
    if (!view || !view.getMode) return;
    if (view.getMode() === "source") {
        const ed = view.editor, cm = ed && ed.cm;
        if (!cm) return;
        line = Math.max(0, Math.min(line, ed.lastLine()));
        const text = ed.getLine(line);
        const from = text.match(LINE_PREFIX_RE)[0].length;
        const to = Math.max(from, text.replace(/\s+\^[\w-]+\s*$/, "").replace(/\s+$/, "").length);
        ed.setSelection({ line, ch: from }, { line, ch: to });
        ed.focus();
        const pos = cm.state.doc.line(line + 1).from;
        cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        await centerOn(cm.scrollDOM, () => { const b = cm.lineBlockAt(pos); return { top: cm.documentTop + b.top, height: b.height }; });
        return;
    }
    const pm = view.previewMode, rd = pm && pm.renderer, sc = rd && rd.previewEl;
    if (!sc) return;
    pm.applyScroll(line);
    let el = null;
    for (let i = 0; i < 12 && !el; i++) { await sleep(i ? 80 : 30); el = previewElAt(rd, line); }
    if (!el) return;
    await centerOn(sc, () => { const cur = previewElAt(rd, line); return cur ? ownRange(cur).getBoundingClientRect() : null; });
    const target = previewElAt(rd, line);
    if (!target) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(ownRange(target));
}

// ---------- 作答动效 ----------
// 提示音用 Web Audio 现场合成，不带音频文件；小烟花是一块铺满窗口的 canvas，pointer-events 关掉，点完就删
const FX = {
    ctx: null,
    audio() {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        if (!this.ctx) this.ctx = new C();
        if (this.ctx.state === "suspended") this.ctx.resume();
        return this.ctx;
    },
    note(ac, f0, f1, dur, delay, gain, type, cut) {
        const t0 = ac.currentTime + (delay || 0);
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type || "sine";
        o.frequency.setValueAtTime(f0, t0);
        if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        let node = o;
        if (cut) { const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cut; o.connect(f); node = f; }
        node.connect(g); g.connect(ac.destination);
        o.start(t0); o.stop(t0 + dur + 0.05);
    },
    noise(ac, dur, delay, gain, f0, f1, q) {
        const t0 = ac.currentTime + (delay || 0);
        const n = Math.ceil(ac.sampleRate * dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
        src.buffer = buf;
        f.type = "bandpass"; f.Q.value = q || 1;
        f.frequency.setValueAtTime(f0, t0);
        f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + dur * 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(f); f.connect(g); g.connect(ac.destination);
        src.start(t0); src.stop(t0 + dur + 0.02);
    },
    // 揭开：一声轻的「唰」往上扫，尾巴挂一个小叮
    reveal(vol) {
        if (!vol) return;
        const ac = this.audio(); if (!ac) return;
        const v = 0.12 * vol;
        this.noise(ac, 0.15, 0, v, 900, 4200, 0.9);
        this.note(ac, 1318.5, 1318.5, 0.22, 0.08, v * 0.6, "sine");
    },
    // 不再作为卡片：「嚓」往下扫，再落一声闷响
    erase(vol) {
        if (!vol) return;
        const ac = this.audio(); if (!ac) return;
        const v = 0.16 * vol;
        this.noise(ac, 0.24, 0, v, 3800, 450, 0.8);
        this.note(ac, 180, 90, 0.18, 0.13, v * 0.8, "sine", 500);
    },
    // 答对：C-E-G-C 往上走的琶音，顶上挂一个高八度的亮片；shift = 连对时往上升几个半音
    up(vol, shift = 0) {
        if (!vol) return;
        const ac = this.audio(); if (!ac) return;
        const v = 0.17 * vol, k = Math.pow(2, Math.min(12, shift) / 12);
        for (const [f, d] of [[523.25, 0], [659.25, 0.07], [783.99, 0.14], [1046.5, 0.21]]) this.note(ac, f * k, f * k, 0.32, d, v, "triangle");
        this.note(ac, 1568 * k, 2093 * k, 0.45, 0.27, v * 0.4, "sine");
    },
    // 今天的目标达成：一个慢慢铺开的大三和弦，上面跑一串高音
    goal(vol) {
        if (!vol) return;
        const ac = this.audio(); if (!ac) return;
        const v = 0.13 * vol;
        for (const [f, d] of [[261.63, 0], [329.63, 0.05], [392, 0.1], [523.25, 0.15]]) this.note(ac, f, f, 1.3, d, v, "triangle", 2400);
        [1046.5, 1318.5, 1568, 2093, 2637].forEach((f, i) => this.note(ac, f, f, 0.28, 0.25 + i * 0.07, v * 0.5, "sine"));
    },
    // 答错：往下掉的两声，低通压掉高频
    down(vol) {
        if (!vol) return;
        const ac = this.audio(); if (!ac) return;
        const v = 0.22 * vol;
        this.note(ac, 196, 165, 0.46, 0, v, "sine", 700);
        this.note(ac, 131, 110, 0.58, 0.1, v * 0.75, "sine", 480);
    },
    // 一行小字从 rect 那儿往上飘、淡出（「连对 ×5」）
    float(rect, text) {
        const el = (window.activeDocument || document).body.createDiv({ cls: "cw-float", text });
        el.setCssStyles({ left: rect.left + rect.width / 2 + "px", top: rect.top + "px" });
        el.animate?.([{ transform: "translate(-50%, 0) scale(.8)", opacity: 0 }, { transform: "translate(-50%, -18px) scale(1.05)", opacity: 1, offset: 0.25 }, { transform: "translate(-50%, -46px) scale(1)", opacity: 0 }], { duration: 1100, easing: "cubic-bezier(.2,.8,.2,1)" });
        setTimeout(() => el.remove(), 1150);
    },
    canvas() {
        const doc = window.activeDocument || document, win = doc.defaultView || window;
        const cv = doc.createElement("canvas");
        cv.className = "cw-fx";
        const dpr = win.devicePixelRatio || 1, W = win.innerWidth, H = win.innerHeight;
        cv.width = W * dpr; cv.height = H * dpr; cv.setCssStyles({ width: W + "px", height: H + "px" });
        doc.body.appendChild(cv);
        const g = cv.getContext("2d"); g.scale(dpr, dpr);
        return { cv, g, W, H };
    },
    // 达标礼花：从进度条上沿撒下一片彩纸
    confetti(rect) {
        if (reducedMotion()) return;
        const { cv, g, W, H } = this.canvas();
        const cols = ["#ffd166", "#ff9f43", "#ff6b6b", "#1dd1a1", "#48dbfb", "#a29bfe", "#3fa877"];
        const ps = Array.from({ length: 70 }, (_, i) => ({
            x: rect.left + Math.random() * rect.width, y: rect.top - 4,
            vx: (Math.random() - 0.5) * 3.2, vy: -2.5 - Math.random() * 3.5,
            w: 4 + Math.random() * 4, h: 7 + Math.random() * 5, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.35,
            c: cols[i % cols.length], life: 1, dec: 0.006 + Math.random() * 0.005,
        }));
        let last = performance.now();
        const step = (now) => {
            const k = Math.min(34, now - last) / 16.7; last = now;
            g.clearRect(0, 0, W, H);
            let alive = false;
            for (const p of ps) {
                if (p.life <= 0 || p.y > H + 20) continue;
                p.vy += 0.09 * k; p.vx *= 0.99; p.vy = Math.min(p.vy, 3.2);
                p.x += (p.vx + Math.sin(p.a) * 0.6) * k; p.y += p.vy * k; p.a += p.va * k; p.life -= p.dec * k;
                alive = true;
                g.save(); g.globalAlpha = Math.min(1, p.life * 1.6); g.translate(p.x, p.y); g.rotate(p.a);
                g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.a * 1.7)), p.w, p.h * Math.abs(Math.cos(p.a * 1.7)) + 1);
                g.restore();
            }
            if (alive) requestAnimationFrame(step); else cv.remove();
        };
        requestAnimationFrame(step);
        setTimeout(() => cv.remove(), 4500);
    },
    // rect 是作答按钮的位置；up = 亮色往上炸，否则暗色往下落
    burst(rect, up) {
        const { cv, g, W, H } = this.canvas();
        const ox = rect.left + rect.width / 2, oy = rect.top + rect.height / 2;
        const cols = up ? ["#ffd166", "#ff9f43", "#ff6b6b", "#1dd1a1", "#48dbfb"] : ["#8b97a6", "#6b7785", "#9a8074", "#7d6b6b"];
        const N = up ? 26 : 13, ps = [];
        for (let i = 0; i < N; i++) {
            const a = up ? (Math.PI * 2 * i) / N + Math.random() * 0.4 : Math.PI * (0.12 + Math.random() * 0.76);
            const sp = up ? 1.8 + Math.random() * 3.4 : 0.6 + Math.random() * 1.5;
            ps.push({ x: ox, y: oy, vx: Math.cos(a) * sp, vy: up ? Math.sin(a) * sp : Math.abs(Math.sin(a)) * sp + 0.5,
                r: up ? 1.6 + Math.random() * 2.2 : 1.2 + Math.random() * 1.5, c: cols[i % cols.length], life: 1, dec: 0.016 + Math.random() * 0.012 });
        }
        let ring = up ? 0 : -1, last = performance.now();
        const step = (now) => {
            const k = Math.min(34, now - last) / 16.7; last = now;
            g.clearRect(0, 0, W, H);
            if (ring >= 0) {
                ring += 2.6 * k;
                if (ring < 42) {
                    g.globalAlpha = 0.5 * (1 - ring / 42);
                    g.strokeStyle = "#ffd166"; g.lineWidth = 2 * (1 - ring / 42) + 0.5;
                    g.beginPath(); g.arc(ox, oy, ring, 0, 6.2832); g.stroke();
                } else ring = -1;
            }
            let alive = false;
            for (const p of ps) {
                if (p.life <= 0) continue;
                p.x += p.vx * k; p.y += p.vy * k;
                p.vy += (up ? 0.075 : 0.1) * k;
                p.vx *= up ? 0.985 : 0.995; p.vy *= 0.985;
                p.life -= p.dec * k;
                if (p.life <= 0) continue;
                alive = true;
                g.globalAlpha = Math.min(1, p.life) * (up ? 1 : 0.5);
                g.fillStyle = p.c;
                g.beginPath(); g.arc(p.x, p.y, p.r * (up ? p.life + 0.3 : 1), 0, 6.2832); g.fill();
            }
            if (alive || ring >= 0) requestAnimationFrame(step); else cv.remove();
        };
        requestAnimationFrame(step);
        setTimeout(() => cv.remove(), 2000);
    },
};
const fxVol = (s) => { const v = Number(s?.fxVolume); return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 0.55; };

// ---------- 中转站：Upstash Redis 的 REST 接口，一次请求带多条命令 ----------
// 键见 DESIGN.md：cw:hb 心跳 / cw:snap + cw:snapv 电脑推的 Anki 快照 / cw:ans 作答 / cw:goal 每台设备每天刷了几张
const K = { hb: "cw:hb", snap: "cw:snap", snapv: "cw:snapv", ans: "cw:ans", goal: "cw:goal" };
const CARD_MAX_MS = 60 * 1000;           // 一张卡最多记这么久的用时
const PHONE_ACTIVE_MS = 3 * 60 * 1000;   // 手机这么久内有心跳 = 正在刷，电脑改成快轮询
const ONLINE_MS = 150 * 1000;            // 电脑这么久内有心跳 = 在线（它闲时最慢 60 秒轮询一次，留够余量）
class Relay {
    constructor(plugin) { this.plugin = plugin; }
    get on() { const s = this.plugin.settings; return !!(String(s.relayUrl).trim() && String(s.relayToken).trim()); }
    async run(cmds) {
        const s = this.plugin.settings;
        const r = await Promise.race([
            requestUrl({ url: String(s.relayUrl).trim().replace(/\/$/, "") + "/pipeline", method: "POST", contentType: "application/json",
                headers: { Authorization: "Bearer " + String(s.relayToken).trim() }, body: JSON.stringify(cmds), throw: false }),
            sleep(12000).then(() => { throw new Error("timeout"); }),
        ]);
        if (r.status !== 200) throw new Error(r.json?.error || `HTTP ${r.status}`);
        const out = r.json;
        const bad = Array.isArray(out) && out.find((x) => x && x.error);
        if (bad) throw new Error(bad.error);
        return (out || []).map((x) => x?.result);
    }
}
// HGETALL 的结果是 [键, 值, 键, 值…]，值是 JSON
function parseHash(arr) {
    const o = {};
    for (let i = 0; arr && i + 1 < arr.length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) { /* 坏的一条跳过 */ } }
    return o;
}

// ---------- 面板 ----------
// 聚焦：那张卡用 transform 从原来的位置滑到可视区正中；换一张时旧的往上翻走、新的从下面翻上来（和 Bullet 的聚焦同一套动效）
const GLIDE_MS = 260, GLIDE_EASE = "cubic-bezier(.2,.8,.2,1)";
const LIVE = ".cw-walk:not(.is-leaving):not(.is-exiting)";
function glide(el, dy, from = 28) {
    if (!el?.animate || reducedMotion()) return;
    if (dy == null) el.animate([{ transform: `translateY(${from}px)`, opacity: 0.2 }, { transform: "none", opacity: 1 }], { duration: GLIDE_MS, easing: GLIDE_EASE });
    else if (Math.abs(dy) >= 2) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: GLIDE_EASE });
}
const flipPose = (dy, deg) => `perspective(900px) translateY(${dy}px) rotateX(${deg}deg) scale(${dy ? 0.97 : 1})`;
function flipIn(el, dir = 1) {
    if (!el?.animate || reducedMotion()) return;
    el.animate([{ transform: flipPose(36 * dir, 26 * dir), transformOrigin: dir > 0 ? "50% 100%" : "50% 0%", opacity: 0 },
        { transform: flipPose(0, 0), transformOrigin: dir > 0 ? "50% 100%" : "50% 0%", opacity: 1 }], { duration: GLIDE_MS, easing: GLIDE_EASE });
}

class CardView extends ItemView {
    constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.shift = 0; }
    getViewType() { return VIEW; }
    getDisplayText() { return t("viewTitle"); }
    getIcon() { return "layers"; }
    // 关掉面板：不等 3 分钟，立刻让 Anki 同步、把这一轮复习记进日记
    async onClose() { this.plugin.viewClosed(); }
    async onOpen() {
        this.registerDomEvent(document, "keydown", (evt) => this.onKey(evt));
        this.registerDomEvent(document, "keydown", (evt) => this.onFocusKey(evt), true);
        // ⌥⌘→ / ⌥⌘← 常被别的命令占着热键（Obsidian 的热键在 window 捕获阶段就接走了）：挂在视图自己的 scope 上
        this.scope = new Scope(this.app.scope);
        this.focusRO = new ResizeObserver(() => this.recenter());
        this.register(() => this.focusRO.disconnect());
        this.plugin.mark = Date.now();   // 面板没开着的时间不算进第一张卡的用时
        await this.render();
        this.plugin.poll();
    }
    bindFocusKeys() {
        for (const h of this.focusHandlers || []) this.scope.unregister(h);
        const hm = this.app.hotkeyManager;
        const keysOf = (id, fallback) => hm?.getHotkeys?.(id) || hm?.getDefaultHotkeys?.(id) || fallback;
        const bind = (keys, fn) => (keys || []).map((h) => this.scope.register(h.modifiers || [], h.key, () => { fn(); return false; }));
        this.focusHandlers = [
            ...bind(keysOf("bullet:zoom-in", [{ modifiers: ["Alt", "Mod"], key: "ArrowRight" }]), () => this.focusIn()),
            ...bind(keysOf("bullet:zoom-out", [{ modifiers: ["Alt", "Mod"], key: "ArrowLeft" }]), () => this.focusOut()),
        ];
    }
    onFocusKey(evt) {
        if (!this.focused || evt.key !== "Escape" || evt.metaKey || evt.ctrlKey || evt.altKey || evt.shiftKey || evt.isComposing) return;
        if (this.app.workspace.getActiveViewOfType(CardView) !== this) return;
        this.focusOut();
        evt.preventDefault(); evt.stopPropagation();
    }
    focusIn() {
        const sel = this.selected?.isConnected && this.selected.matches(LIVE) ? this.selected : null;
        const c = sel || this.contentEl.querySelector(LIVE);
        if (!c) { new Notice(t("noFocus")); return; }
        if (this.focused && c.hasClass("is-focus")) return;
        const before = c.getBoundingClientRect().top;
        this.focused = true;
        this.contentEl.addClass("cw-focus-mode");
        this.focusOn(c, before);
    }
    focusOn(c, before, dir = 1) {
        this.contentEl.querySelectorAll(".cw-walk.is-focus").forEach((x) => { if (x !== c) { x.removeClass("is-focus", "has-more"); x.setCssStyles({ marginTop: "" }); } });
        c.addClass("is-focus");
        c.toggleClass("has-more", this.contentEl.querySelectorAll(LIVE).length > 1 || !!this.walkQueue?.length);
        this.select(c);
        this.contentEl.scrollTop = 0;
        this.placeFocus(c);
        if (before == null) flipIn(c, dir);
        else glide(c, before - c.getBoundingClientRect().top);
        this.focusRO.disconnect();
        this.focusRO.observe(this.contentEl);
        this.focusRO.observe(c);
    }
    // 放得下就让卡片中线对齐可视区中线；放不下就贴着标题下面。用布局位置量（不含正在播的 transform）
    placeFocus(c) {
        c.setCssStyles({ marginTop: "" });
        const el = this.contentEl;
        const topOf = () => { let y = 0, n = c; for (; n && n !== el; n = n.offsetParent) y += n.offsetTop; return n === el ? y : null; };
        const y = topOf();
        if (y == null) return;
        const want = el.scrollTop + (el.clientHeight - c.offsetHeight) / 2;
        if (want <= y) return;
        const base = parseFloat(getComputedStyle(c).marginTop) || 0;
        let push = base + want - y;
        c.setCssStyles({ marginTop: Math.round(push) + "px" });
        push += want - topOf();
        c.setCssStyles({ marginTop: Math.round(Math.max(0, push)) + "px" });
    }
    recenter() {
        const c = this.focused && this.contentEl.querySelector(".cw-walk.is-focus:not(.is-exiting)");
        if (!c) return;
        const before = c.offsetTop;
        this.placeFocus(c);
        if (!c.getAnimations?.().length) glide(c, before - c.offsetTop);
    }
    flipOut(c, dir = 1) {
        if (!c?.isConnected || !c.animate || reducedMotion()) return;
        const el = this.contentEl, box = el.getBoundingClientRect(), r = c.getBoundingClientRect();
        const ghost = c.cloneNode(true);
        ghost.className = "cw-card cw-flip-ghost";
        ghost.setCssStyles({ top: `${r.top - box.top - el.clientTop + el.scrollTop}px`, left: `${r.left - box.left - el.clientLeft}px`, width: `${r.width}px`, height: `${r.height}px`, marginTop: "0" });
        el.appendChild(ghost);
        const origin = dir > 0 ? "50% 0%" : "50% 100%";
        ghost.animate([{ transform: flipPose(0, 0), transformOrigin: origin, opacity: 1 },
            { transform: flipPose(-32 * dir, -34 * dir), transformOrigin: origin, opacity: 0 }], { duration: GLIDE_MS, easing: GLIDE_EASE, fill: "forwards" })
            .finished.catch(() => {}).then(() => ghost.remove());
    }
    focusOut() {
        if (!this.focused) return;
        const c = this.contentEl.querySelector(".cw-walk.is-focus");
        const before = c?.getBoundingClientRect().top;
        this.focused = false;
        this.focusRO.disconnect();
        this.contentEl.removeClass("cw-focus-mode");
        if (!c) return;
        c.removeClass("is-focus", "has-more");
        c.setCssStyles({ marginTop: "" });
        c.scrollIntoView({ block: "nearest" });
        glide(c, before - c.getBoundingClientRect().top);
        if (!reducedMotion()) for (const x of this.contentEl.querySelectorAll(".cw-sec, .cw-walk")) {
            if (x !== c && x !== c.parentElement) x.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS, easing: "ease" });
        }
    }
    // 键盘作答：点一下卡片选中它，Space 揭开，1-4 = 重来 / 困难 / 良好 / 简单；↑↓ 换一张。只在这个面板是当前焦点时生效
    onKey(evt) {
        if (this.app.workspace.getActiveViewOfType(CardView) !== this) return;
        if (evt.metaKey || evt.ctrlKey || evt.altKey || evt.isComposing) return;
        if (evt.target instanceof HTMLElement && evt.target.closest("input, textarea, select, [contenteditable='true']")) return;
        const cards = [...this.contentEl.querySelectorAll(LIVE)];
        const c = this.selected?.isConnected && this.selected.matches(LIVE) ? this.selected : null;
        if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
            if (!cards.length) return;
            evt.preventDefault();
            if (evt.key === "ArrowUp" && c && cards[0] === c && this.history?.length > this.backEls.length) { this.back(); return; }
            const i = c ? cards.indexOf(c) + (evt.key === "ArrowDown" ? 1 : -1) : 0;
            const to = cards[Math.max(0, Math.min(cards.length - 1, i))];
            if (this.focused) { if (to !== c) { const dir = evt.key === "ArrowDown" ? 1 : -1; this.flipOut(c, dir); this.focusOn(to, null, dir); } }
            else this.select(to, true);
            return;
        }
        if (!c) return;
        const btn = evt.key === " " ? c.querySelector(".cw-reveal") : /^[1-4]$/.test(evt.key) ? c.querySelector(`.cw-ease.is-${evt.key}`) : null;
        if (evt.key === " " || btn) evt.preventDefault();
        if (btn && !btn.disabled) btn.click();
    }
    select(c, scroll) {
        if (this.selected && this.selected !== c) this.selected.removeClass("is-selected");
        this.selected = c || null;
        if (!c) return;
        c.addClass("is-selected");
        if (scroll) c.scrollIntoView({ block: "nearest" });
    }
    async render() {
        // 渲染是异步的，连着触发两次会交错：每次编号，等完异步回来发现有更新的一次就不再往面板里写
        const seq = (this.renderSeq = (this.renderSeq || 0) + 1);
        const stale = () => seq !== this.renderSeq;
        const el = this.contentEl; el.empty(); el.addClass("cw-view");
        this.selected = null;
        this.bindFocusKeys();
        const today = M().format("YYYY-MM-DD");
        const top = el.createDiv({ cls: "cw-top" });
        const head = top.createDiv({ cls: "cw-head" });
        head.createEl("b", { text: t("head", { date: today }) });
        const btns = head.createSpan({ cls: "cw-head-btns" });
        this.backEls = [];
        this.backBtn = btns.createEl("button", { text: "↶", attr: { "aria-label": t("backTip") } });
        this.backBtn.onclick = () => this.back();
        this.backBtn.disabled = !this.history?.length;
        const fz = btns.createEl("button", { text: "◎", cls: "cw-focus-btn", attr: { "aria-label": t("focusTip") } });
        fz.onclick = () => (this.focused ? this.focusOut() : this.focusIn());
        const again = btns.createEl("button", { text: "↻", attr: { "aria-label": t("againTip") } });
        again.onclick = () => { this.shift++; this.render(); };
        const p = this.plugin;
        this.pauseBtn = p.settings.reviewLog ? btns.createEl("button", { cls: "cw-pause-btn" }) : null;
        if (this.pauseBtn) this.pauseBtn.onclick = () => p.setPaused(!p.paused);
        this.updatePause();
        this.syncEl = top.createDiv({ cls: "cw-sync" });
        this.renderSync();
        this.goalEl = top.createDiv({ cls: "cw-goal" });
        this.updateGoal();
        await this.renderWalk(el, today, stale);
        if (stale()) return;
        if (this.focused) { const f = el.querySelector(LIVE); if (f) this.focusOn(f, null); }
    }
    updatePause() {
        const on = !!this.plugin.paused;
        this.contentEl.toggleClass("is-paused", on);
        if (!this.pauseBtn) return;
        this.pauseBtn.setText(on ? "▶︎" : "‖");   // ⏸ 在 macOS 上会画成彩色 emoji，和旁边的 ◎ ↻ 不配
        this.pauseBtn.setAttr("aria-label", t(on ? "resumeTip" : "pauseTip"));
    }
    // ----- 同步状态条：一行结论，点开是设备和最近的作答（每一步） -----
    renderSync() {
        const el = this.syncEl;
        if (!el?.isConnected) return;
        const p = this.plugin, v = p.syncView();
        el.empty();
        el.className = `cw-sync is-${v.level}`;
        const line = el.createDiv({ cls: "cw-sync-line" });
        line.createSpan({ cls: "cw-dot" });
        line.createSpan({ cls: "cw-sync-text", text: v.text });
        if (p.relay.on) line.createSpan({ cls: "cw-sync-caret", text: this.syncOpen ? "▾" : "▸" });
        if (v.sub) el.createDiv({ cls: "cw-sync-sub", text: v.sub });
        if (v.hint) el.createDiv({ cls: "cw-sync-hint", text: v.hint });
        line.onclick = () => { if (!p.relay.on) return; this.syncOpen = !this.syncOpen; if (this.syncOpen) p.poll(); this.renderSync(); };
        if (this.syncOpen && p.relay.on) this.renderSyncDetail(el.createDiv({ cls: "cw-sync-detail" }));
    }
    renderSyncDetail(box) {
        const p = this.plugin, now = Date.now();
        box.createDiv({ cls: "cw-sync-h", text: t("devices") });
        for (const [id, d] of Object.entries(p.devices || {}).sort((a, b) => b[1].at - a[1].at)) {
            const row = box.createDiv({ cls: "cw-dev" + (now - d.at < (d.kind === "mobile" ? PHONE_ACTIVE_MS : ONLINE_MS) ? " is-on" : "") });
            row.createSpan({ text: (d.kind === "mobile" ? "📱 " : "💻 ") + (d.name || id) + (id === p.local.dev ? t("thisDev") : "") });
            row.createSpan({ cls: "cw-dev-at", text: ago(d.at) + (d.kind === "desktop" ? ` · ${d.anki ? t("ankiOn") : t("ankiOff")}` : "") });
        }
        box.createDiv({ cls: "cw-sync-h", text: t("recent") });
        const list = p.recentAnswers();
        if (!list.length) { box.createDiv({ cls: "cw-hint", text: t("none") }); return; }
        for (const x of list.slice(0, 30)) {
            const row = box.createDiv({ cls: "cw-ans" });
            row.createSpan({ cls: "cw-ans-at", text: moment(x.at).format("HH:mm") });
            row.createSpan({ cls: `cw-ans-ease is-${x.ease}`, text: t("ease" + x.ease) });
            row.createSpan({ cls: "cw-ans-dev", text: p.devName(x.dev) });
            const st = row.createSpan({ cls: "cw-stages" });
            const stage = x.state;   // local / queued / applying / applied / rejected
            const step = (label, done, warn) => st.createSpan({ cls: "cw-stage" + (done ? " is-done" : "") + (warn ? " is-bad" : ""), text: label });
            step(t("stSaved"), true);
            st.createSpan({ cls: "cw-stage-sep", text: "→" });
            step(t("stUp"), stage !== "local");
            st.createSpan({ cls: "cw-stage-sep", text: "→" });
            if (stage === "rejected") step(t("rejectedAs", { e: x.err || "" }), false, true);
            else step(stage === "applied" ? `${t("stAnki")} · ${x.ivl ? t("ivl", { n: x.ivl }) : t("ivl0")}` : t("stAnki"), stage === "applied");
        }
    }
    // 今天的刷卡进度：已刷 / 目标，下面最近 14 天每天刷了几张 + 连续天数
    updateGoal() {
        const g = this.goalEl;
        if (!g?.isConnected) return;
        const p = this.plugin, done = p.goalDone(), goal = p.goalTarget();
        g.empty();
        g.toggleClass("is-met", done >= goal);
        const bar = g.createDiv({ cls: "cw-goal-bar" });
        bar.createDiv({ cls: "cw-goal-fill" }).setCssStyles({ width: Math.min(100, (done / goal) * 100) + "%" });
        g.createSpan({ cls: "cw-goal-text", text: t(done >= goal ? "goalMet" : "goal", { done, goal }) });
        const days = p.reviewDaysCache?.map;
        if (days) {
            const row = g.createDiv({ cls: "cw-streak" });
            const today = M().format("YYYY-MM-DD");
            const n = (d) => Math.max(days[d] || 0, p.dayCount(d));
            for (let i = 13; i >= 0; i--) {
                const d = M().subtract(i, "days").format("YYYY-MM-DD"), k = n(d);
                row.createSpan({ cls: "cw-day" + (k >= goal ? " is-met" : k ? " is-some" : ""), attr: { "aria-label": t("dayTip", { d, n: k }) } });
            }
            let streak = 0;
            for (let i = n(today) ? 0 : 1; n(M().subtract(i, "days").format("YYYY-MM-DD")); i++) streak++;
            row.createSpan({ cls: "cw-streak-text", text: streak ? t("streak", { n: streak }) : t("streak0") });
        } else p.reviewDays().then((ok) => { if (ok) this.updateGoal(); });
        this.updateLeft();
    }
    bumpGoal() {
        const g = this.goalEl;
        if (!g?.isConnected || reducedMotion()) return;
        g.querySelector(".cw-goal-fill")?.animate?.([{ filter: "brightness(1.35)", transform: "scaleY(1.6)" }, { filter: "none", transform: "none" }], { duration: 420, easing: GLIDE_EASE });
        g.querySelector(".cw-goal-text")?.animate?.([{ transform: "scale(1.18)" }, { transform: "none" }], { duration: 320, easing: GLIDE_EASE });
    }
    updateLeft() {
        const el = this.leftEl;
        if (!el?.isConnected) return;
        const k = this.contentEl.querySelectorAll(LIVE + ":not(.is-prev)").length + (this.walkQueue?.length || 0);
        el.setText(k ? t("left", { n: k }) : "");
    }
    walkFinished(box) {
        const p = this.plugin, done = p.goalDone(), goal = p.goalTarget();
        const f = box.createDiv({ cls: "cw-finish" + (done >= goal ? " is-met" : "") });
        if (done >= goal) {
            const svg = f.createDiv({ cls: "cw-check" }).createSvg("svg", { attr: { viewBox: "0 0 52 52" } });
            svg.createSvg("circle", { attr: { cx: 26, cy: 26, r: 23 } });
            svg.createSvg("path", { attr: { d: "M15 27 l7 7 l15 -16" } });
        }
        f.createDiv({ cls: "cw-finish-t", text: done >= goal ? t("finishMet", { goal }) : t("finish") });
        f.createDiv({ cls: "cw-hint", text: done >= goal ? t("finishMetHint") : t("finishHint") });
        const more = f.createEl("button", { text: t("more10") });
        more.onclick = () => { this.target = Math.max(goal, done) + 10; this.targetDay = M().format("YYYY-MM-DD"); this.render(); };
        this.updateLeft();
    }
    // 随机漫步：从 #card 卡片和 ==挖空== 里抽，两类轮流来；Anki 今天到期的排最前（快照里能答的也排前面）
    // 分类：知识（默认）/ 语言（设了语言规则才有）/ 按学科；按新增时间圈范围：7 天 / 1 个月 / 全部。范围只决定抽哪些，不改 Anki 的排程
    async renderWalk(el, today, stale = () => false) {
        const p = this.plugin, n = p.settings.reviewCount;
        const subs = p.subjects();
        const hasLang = p.langOn();
        const want = p.local.walkMode;
        const mode = want === "main" || (want === "lang" && hasLang) || (want?.startsWith("s:") && (subs.some((x) => "s:" + x.name === want) || want === "s:" + t("other"))) ? want : "main";
        const subj = mode.startsWith("s:") ? mode.slice(2) : null;
        const range = WALK_RANGES.some((r) => r[0] === p.local.walkRange) ? p.local.walkRange : "all";
        const days = WALK_RANGES.find((r) => r[0] === range)[2];
        const since = days ? moment(today, "YYYY-MM-DD").subtract(days - 1, "days").valueOf() : -Infinity;
        const pool = await p.walkPool();
        if (stale()) return;
        const lang = mode === "lang";
        const pick = (arr) => arr.filter((it) => !!it.lang === lang && it.at >= since && (!subj || p.subjectOf(it) === subj));
        const src = { card: pick(pool.card), cloze: pick(pool.cloze) };
        let dueN = new Set();
        if (p.settings.ankiReview) { try { dueN = await p.ankiDueNotes(); } catch (e) { /* Anki 没开：照常随机 */ } }
        if (stale()) return;
        const rand = rng(today + "#" + this.shift + "#" + mode + "#" + range);
        const yearAgo = Date.now() - 365 * 864e5, boost = Math.max(1, Number(p.settings.recentBoost) || 1);
        const hot = new Set(split(p.settings.boostLinks).map((x) => x.toLowerCase()));
        const lboost = Math.max(1, Number(p.settings.linkBoost) || 1);
        const shuffle = (arr, r) => weightedShuffle(arr, r, (it) => (it.at >= yearAgo ? boost : 1) * (it.links?.some((x) => hot.has(x)) ? lboost : 1));
        const due = dueN.size ? shuffle([...src.card, ...src.cloze].filter((it) => dueN.has(p.nidOf(it))), rand) : [];
        const s = el.createDiv({ cls: "cw-sec cw-walk-sec" });
        const h = s.createDiv({ cls: "cw-sec-h" });
        const title = h.createEl("span", { text: t("walk") });
        h.createEl("span", { cls: "cw-hint", text: t("counts", { c: src.card.length, z: src.cloze.length }) + (due.length ? t("dueN", { n: due.length }) : "") });
        this.leftEl = h.createSpan({ cls: "cw-hint cw-left" });
        if (hasLang) {
            const tabs = title.createSpan({ cls: "cw-tabs" });
            for (const [m, label] of [["main", t("tabMain")], ["lang", t("tabLang")]]) {
                const b = tabs.createEl("button", { text: label, cls: m === mode || (m === "main" && subj) ? "is-active" : "" });
                b.onclick = async () => { p.local.walkMode = m; p.saveLocal(); this.render(); };
            }
        }
        const rtabs = title.createSpan({ cls: "cw-tabs cw-range" });
        for (const [r, key] of WALK_RANGES) {
            const b = rtabs.createEl("button", { text: t(key), cls: r === range ? "is-active" : "" });
            b.onclick = async () => { p.local.walkRange = r; p.saveLocal(); this.render(); };
        }
        // 按学科刷：「知识」下面一排学科，后面是这门在当前范围里的张数
        if (subs.length && (mode === "main" || subj)) {
            const row = s.createDiv({ cls: "cw-subjects" });
            const inRange = [...pool.card, ...pool.cloze].filter((it) => !it.lang && it.at >= since);
            const count = {};
            for (const it of inRange) { const k = p.subjectOf(it); count[k] = (count[k] || 0) + 1; }
            const chips = [["main", t("all"), inRange.length], ...subs.map((x) => ["s:" + x.name, x.name, count[x.name] || 0]), ["s:" + t("other"), t("other"), count[t("other")] || 0]];
            for (const [m, label, k] of chips) {
                if (m !== "main" && !k && m !== mode) continue;
                const b = row.createEl("button", { cls: "cw-subject" + (m === mode ? " is-active" : "") });
                b.createSpan({ text: label });
                b.createSpan({ cls: "cw-subject-n", text: String(k) });
                b.onclick = async () => { p.local.walkMode = m; p.saveLocal(); this.render(); };
            }
        }
        // 排好整条队列：到期的在前，其余两类轮流
        const order = [...due], taken = new Set(due);
        const lists = shuffle(Object.keys(src), rand).map((k) => shuffle(src[k], rand).filter((x) => !taken.has(x)));
        for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) order.push(l[i]);
        // 能作答的排前面：按快照，Anki 里还没到期 / 学习中的卡只能看，挪到后面，别占这一批的名额
        const snap = p.snap;
        if (MOBILE && snap) {
            const can = (it) => { const nid = p.nidOf(it), c = nid && snap.notes[String(nid)]; return !!c && c.some((x) => snap.due.has(x) || snap.new.has(x)); };
            const head = order.slice(0, due.length), rest = order.slice(due.length);
            order.splice(0, order.length, ...head, ...rest.filter(can), ...rest.filter((it) => !can(it)));
        }
        if (!order.length) {
            s.createDiv({ cls: "cw-hint", text: lang ? t("emptyLang") : subj ? t("emptySubj", { s: subj }) : days ? t("emptyRange", { n: days }) : t("emptyAll") });
            return;
        }
        this.walkBox = s;
        // 每天一批：到期的在前，补满到今天的目标（刷够了就收工，「再来 10 张」再加）
        if (this.targetDay !== today) { this.target = 0; this.targetDay = today; }
        const left = Math.max(0, Math.max(p.goalTarget(), this.target || 0) - p.goalDone());
        if (!left) { this.walkQueue = []; this.walkFinished(s); return; }
        const batch = order.slice(0, left);
        this.walkQueue = batch.slice(n);
        for (const it of batch.slice(0, n)) this.walkCard(s, it);
        this.updateLeft();
    }
    // 这张处理完了：收起来，后面的往上顶，从队列里补一张；聚焦着的那一张当场往上翻走，下一张从下面翻上来
    dismissWalk(c) {
        if (!c.matches(LIVE)) return;
        // 答完的记进历史，之后能一张张往回看；正在往回看的那几张收起来
        const st = c.cwState?.st;
        if (st?.answered) {
            this.dropBack();
            (this.history ||= []).push({ it: st.it, ease: st.ease, label: st.label });
            if (this.backBtn) this.backBtn.disabled = false;
        }
        const inFocus = this.focused && c.hasClass("is-focus");
        if (inFocus) { c.addClass("is-exiting"); this.flipOut(c, 1); }
        else {
            c.setCssStyles({ height: c.offsetHeight + "px" });
            c.addClass("is-leaving");
            requestAnimationFrame(() => c.setCssStyles({ height: "0px" }));
        }
        const finish = () => {
            const box = c.parentElement;
            const wasSel = this.selected === c, at = box ? [...box.querySelectorAll(".cw-walk:not(.is-prev)")].indexOf(c) : -1;
            c.remove();
            const next = box === this.walkBox ? this.walkQueue?.shift() : null;
            if (next) this.walkCard(box, next);
            else if (box && !box.querySelector(".cw-walk:not(.is-prev)") && box === this.walkBox) this.walkFinished(box);
            this.updateLeft();
            if (wasSel || inFocus) {
                const rest = box ? [...box.querySelectorAll(LIVE + ":not(.is-prev)")] : [];
                const to = rest[Math.min(at, rest.length - 1)];
                if (inFocus && this.focused && to) this.focusOn(to, null);
                else this.select(to, true);
            }
        };
        if (inFocus) finish(); else setTimeout(finish, GLIDE_MS);
    }
    // 往回看：从现在这张（正在看的往回那张，或面板上的卡）再往回一张。往回的卡只读（揭开着，带当时的作答结果），越早的摆得越靠上；聚焦着就翻过去
    back() {
        const box = this.walkBox, cur = this.focused ? this.contentEl.querySelector(".cw-walk.is-focus:not(.is-exiting)") : this.selected;
        const depth = (this.backEls.indexOf(cur) + 1) + 1;   // 倒数第几张：1 = 刚答完的那张
        let c = this.backEls[depth - 1];
        if (!c?.isConnected) {
            const h = this.history || [];
            if (depth > h.length || !box?.isConnected) { new Notice(t("noPrev")); return; }
            c = this.walkCard(box, h[h.length - depth], depth);
            const top = [...box.children].find((x) => x !== c && (x.hasClass("cw-walk") || x.hasClass("cw-finish")));
            if (top) box.insertBefore(c, top);
            this.backEls[depth - 1] = c;
            if (!this.focused) glide(c, null, -28);
        }
        if (this.focused) { if (c !== cur) { this.flipOut(cur, -1); this.focusOn(c, null, -1); } }
        else this.select(c, true);
    }
    // 又答完一张：往回看的那几张收起来（历史还在，随时能再往回）
    dropBack() {
        for (const e of this.backEls || []) {
            if (!e.isConnected) continue;
            e.setCssStyles({ height: e.offsetHeight + "px" });
            e.addClass("is-leaving");
            requestAnimationFrame(() => e.setCssStyles({ height: "0px" }));
            setTimeout(() => e.remove(), GLIDE_MS);
        }
        this.backEls = [];
    }
    // depth：往回看的第几张（只看不答，显示当时的作答结果），这时 it 是历史里的那条 { it, ease, label }
    walkCard(parent, it, depth) {
        const prev = depth ? it : null;
        if (prev) it = prev.it;
        const p = this.plugin;
        const c = parent.createDiv({ cls: `cw-card cw-walk is-${it.kind}` + (prev ? " is-prev" : "") });
        const meta = c.createDiv({ cls: "cw-meta" });
        const jd = p.journalDate(it.file);
        const where = jd ? jd.format("YYYY-MM-DD") : it.file.basename;
        const subj = !it.lang && p.subjects().length ? ` · ${p.subjectOf(it)}` : "";
        meta.createEl("span", { text: `${it.kind === "card" ? t("kCard") : t("kCloze")} · ${where}${subj}` + (it.again ? t("again") : "") + (prev ? t("prevTag", { n: depth }) : "") });
        const bc = it.ctx?.length ? c.createDiv({ cls: "cw-crumbs" }) : null;
        // 按 Markdown 渲染；点里面的双链跳过去，⌘ 点别处打开原文
        const body = c.createDiv({ cls: "cw-text cw-md markdown-rendered" });
        body.addEventListener("click", (evt) => {
            const a = evt.target.closest("a.internal-link");
            if (!a) { if (evt.target.closest("a, img")) evt.stopPropagation(); return; }
            evt.preventDefault(); evt.stopPropagation();
            this.app.workspace.openLinkText(a.getAttribute("data-href") || a.getAttribute("href"), it.file.path, Keymap.isModEvent(evt));
        });
        const md = cardMd(it.text);
        const lines = md.split("\n");
        const full = clozeReveal(md);
        // 卡片：第一行是问题，子项是答案；挖空：遮住（一条笔记在 Anki 里有好几张卡时，只遮这次要复习的那个空）
        const hiddenOf = (target) => it.kind === "card" ? lines[0] + (lines.length > 1 ? "\n\n…" : "") : clozeMask(md, target);
        // 「重来」后排回来的那张不再算进今天的张数；level = 展开到第几层母块（null = 只看卡片本身）
        const st = { revealed: !!prev || hiddenOf(null) === full, answered: !!prev, level: null, card: null, reviewable: false, it, goal: !!it.again, done: () => this.dismissWalk(c) };
        // 按现在的样子画正文：没揭开的照旧遮着。展开了母块就画那一整块，卡片本身那一块加底色（原文要现读：卡池最多留 10 分钟）
        const paint = async () => {
            const seq = (st.paintSeq = (st.paintSeq || 0) + 1);
            const m = st.revealed ? full : hiddenOf(st.target ?? null);
            const x = st.level != null && it.ctx[st.level];
            let out = m;
            if (x) {
                const L = (await this.app.vault.cachedRead(it.file)).split("\n");
                const items = this.app.metadataCache.getFileCache(it.file)?.listItems || [];
                const end = listEnds(items).get(x.line);
                if (seq !== st.paintSeq) return;
                if (end == null || L.slice(it.line, it.end + 1).join("\n") !== it.text) { new Notice(t("ctxStale")); st.level = null; crumbs(); }
                else out = ctxMd(L, x.line, end, it, !st.revealed && it.kind === "card" ? lines[0] + (lines.length > 1 ? "\n\t- …" : "") : m);
            }
            body.empty();
            await MarkdownRenderer.render(this.app, out, body, it.file.path, this);
            if (seq !== st.paintSeq || out === m) return;
            const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = tw.nextNode()) && !n.data.includes(SELF_MARK));
            if (!n) return;
            n.data = n.data.replace(SELF_MARK, "");
            const li = n.parentElement.closest("li");
            if (!li) return;
            li.addClass("cw-ctx-self");
            body.scrollTop += li.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
        };
        // 母块：包着这张卡的各层，从外到内。点哪一层就展开到哪一层（和 Roam 反链一样：显示那一块连同下面所有子块，面包屑只留更外面的几层）；⌘ 点跳到原文
        const crumbs = () => {
            if (!bc) return;
            bc.empty();
            it.ctx.slice(0, st.level ?? it.ctx.length).forEach((x, i) => {
                if (i) bc.createSpan({ cls: "cw-crumb-sep", text: " › " });
                const tx = plain(x.text);
                const a = bc.createSpan({ cls: "cw-crumb", text: tx.length > 40 ? tx.slice(0, 39) + "…" : tx, attr: { "aria-label": (tx.length > 40 ? tx + "\n" : "") + t("crumbTip") } });
                a.onclick = (evt) => { evt.stopPropagation(); if (Keymap.isModEvent(evt)) p.openAt(it.file, x.line, evt); else { st.level = i; crumbs(); paint(); } };
            });
            if (st.level == null) return;
            const f = bc.createSpan({ cls: "cw-crumb cw-crumb-fold", text: t("fold") });
            f.onclick = (evt) => { evt.stopPropagation(); st.level = null; crumbs(); paint(); };
        };
        crumbs();
        paint();
        if (prev) {
            c.cwState = { st, refill: () => {} };
            c.createDiv({ cls: "cw-anki is-done", text: `${t("ease" + prev.ease)} · ${prev.label}` });
            c.addEventListener("mousedown", () => this.select(c));
            c.onclick = (evt) => { if (Keymap.isModEvent(evt)) p.openAt(it.file, it.line, evt); };
            return c;
        }
        const row = c.createDiv({ cls: "cw-actions" });
        const anki = p.settings.ankiReview ? c.createDiv({ cls: "cw-anki", text: "…" }) : null;
        const onTarget = () => { if (!st.revealed && it.kind === "cloze" && st.target) paint(); };
        const reveal = () => {
            st.revealed = true; paint(); row.empty();
            if (p.settings.fxSound) FX.reveal(fxVol(p.settings));
            p.spend(st);
            p.reviewTick(st, "look");
            if (st.reviewable) this.answerButtons(row, anki, st);
        };
        if (hiddenOf(null) !== full) {
            const b = row.createEl("button", { text: t("reveal"), cls: "cw-reveal" });
            b.onclick = (evt) => { evt.stopPropagation(); reveal(); };
        }
        // 进度变了（另一台设备答过、补写了手机的作答）时重查这张能不能答：recheck 用
        c.cwState = { st, refill: () => anki && !st.answered && this.fill(it, anki, row, st, onTarget) };
        if (anki) this.fill(it, anki, row, st, onTarget);
        c.addEventListener("mousedown", () => this.select(c));
        c.onclick = (evt) => { if (Keymap.isModEvent(evt)) p.openAt(it.file, it.line, evt); };
        // 右键：不再作为卡片（只去掉 #card / 挖空符号，文字留着）
        c.addEventListener("contextmenu", (evt) => {
            evt.preventDefault(); evt.stopPropagation();
            const menu = new Menu();
            menu.addItem((i) => i.setTitle(it.kind === "card" ? t("uncardCard") : t("uncardCloze")).setIcon("eraser").onClick(async () => {
                if (await p.uncard(it)) { if (p.settings.fxSound) FX.erase(fxVol(p.settings)); this.dismissWalk(c); }
            }));
            menu.addItem((i) => i.setTitle(t("openSrc")).setIcon("file-text").onClick(() => p.openAt(it.file, it.line)));
            menu.showAtMouseEvent(evt);
        });
        return c;
    }
    // 拿到新进度（快照换了、补写了手机的作答）：面板上还没答的卡重查一遍能不能答
    recheck() {
        for (const c of this.contentEl.querySelectorAll(LIVE)) c.cwState?.refill();
    }
    fill(it, el, row, st, onTarget) { return MOBILE ? this.fillSnap(it, el, row, st, onTarget) : this.fillAnki(it, el, row, st, onTarget); }
    setReviewable(el, row, st, ok) {
        const was = st.reviewable;
        st.reviewable = ok;
        el.toggleClass("is-off", !ok);
        // 揭开后变得不能答了（别的设备刚答过）：收掉按钮；变得能答了：补上按钮
        if (st.revealed && was !== ok) { row.empty(); if (ok) this.answerButtons(row, el, st); }
        else if (st.revealed && ok && !row.querySelector(".cw-ease")) { row.empty(); this.answerButtons(row, el, st); }
    }
    // 电脑上：直接查 Anki；到期的和新卡可以作答
    async fillAnki(it, el, row, st, onTarget) {
        const p = this.plugin;
        el.empty(); el.removeClass("is-off");
        const nid = p.nidOf(it);
        if (!nid) { el.setText(t("notInAnki")); this.setReviewable(el, row, st, false); return; }
        let cards;
        try {
            const ids = await p.anki("findCards", { query: `nid:${nid}` });
            if (!ids.length) { el.setText(t("noAnkiCard")); this.setReviewable(el, row, st, false); return; }
            cards = await p.anki("cardsInfo", { cards: ids });
            const due = await p.anki("areDue", { cards: ids });
            cards.forEach((x, i) => (x._due = due[i]));
        } catch (e) {
            el.setText(t("ankiDown"));
            const b = el.createEl("button", { text: t("retry") });
            b.onclick = (evt) => { evt.stopPropagation(); this.fillAnki(it, el, row, st, onTarget); };
            this.setReviewable(el, row, st, false);
            return;
        }
        const live = cards.filter((x) => x.queue >= 0);
        const card = live.find((x) => x._due) || live.find((x) => x.queue === 0) || live.sort((a, b) => a.due - b.due)[0] || cards[0];
        st.card = card;
        if (cards.length > 1 && it.kind === "cloze") { st.target = card.ord + 1; onTarget(); }
        // 手机上已经答了、还排着队没补进 Anki 的：这里别再答一遍
        const queued = !st.it?.again && p.pendingFor(cards.map((x) => x.cardId));
        if (queued) { el.setText(t("queuedPhone", { dev: p.devName(queued.dev) })); this.setReviewable(el, row, st, false); return; }
        el.setText(await p.ankiState(card));
        // 「重来」后排回来的那张在 Anki 里是学习中（几分钟后才到期），这里提前作答，相当于 Anki 的「提前学习」
        this.setReviewable(el, row, st, card.queue === 0 || (card.queue > 0 && card._due) || (!!st.it?.again && (card.queue === 1 || card.queue === 3)));
    }
    // 手机上：卡片状态取电脑推到中转站的快照，作答经中转站交给电脑写进 Anki
    fillSnap(it, el, row, st) {
        const p = this.plugin, snap = p.snap;
        el.empty();
        const nid = p.nidOf(it);
        if (!nid) { el.setText(t("notInAnki")); this.setReviewable(el, row, st, false); return; }
        if (!p.relay.on) { el.setText(t("noRelay")); this.setReviewable(el, row, st, false); return; }
        if (!snap) { el.setText(t("noSnap")); this.setReviewable(el, row, st, false); return; }
        const cids = snap.notes[String(nid)];
        if (!cids?.length) { el.setText(t("noAnkiCard")); this.setReviewable(el, row, st, false); return; }
        const due = cids.find((c) => snap.due.has(c)), nw = cids.find((c) => snap.new.has(c)), lr = cids.find((c) => snap.learn.has(c));
        st.card = { cardId: due || nw || lr || cids[0] };
        const by = !st.it?.again && p.answeredSince(cids);
        const ok = !by && (!!(due || nw) || (!!st.it?.again && !!lr));
        // 刚才还能答、拿到新进度后不能答了：多半是在电脑（或 Anki 本身）上刚答过，说清楚，免得以为卡坏了
        const label = by ? (by === p.local.dev ? t("answeredHere") : t("answeredOn", { dev: p.devName(by) })) : st.reviewable && !ok ? t("changedElsewhere") : due ? t("dueToday") : nw ? t("isNew") : lr ? t("learning") : t("notDue");
        el.setText(label);
        this.setReviewable(el, row, st, ok);
    }
    answerButtons(row, el, st) {
        const p = this.plugin;
        for (const ease of [1, 2, 3, 4]) {
            const b = row.createEl("button", { text: t("ease" + ease), cls: `cw-ease is-${ease}` });
            b.onclick = async (evt) => {
                evt.stopPropagation();
                const rect = b.getBoundingClientRect();   // 先取位置：按钮马上要被清掉，烟花得知道在哪儿炸
                row.querySelectorAll("button").forEach((x) => (x.disabled = true));
                p.spend(st);
                const dur = Math.max(1, Math.round(st.ms / 1000));   // AnkiConnect 的 duration 按秒
                try {
                    let label;
                    if (MOBILE) {
                        const up = await p.recordAnswer(st.card.cardId, ease, dur);
                        label = up ? t("savedUp") : t("savedLocal");
                    } else {
                        if (!(await p.answerCard(st.card.cardId, ease, dur))) throw new Error(t("rejected"));
                        const [after] = await p.anki("cardsInfo", { cards: [st.card.cardId] });
                        p.dueCache = null;
                        p.scheduleAnkiSync();
                        p.snapSoon();
                        label = after.queue === 2 ? t("nextDays", { n: after.interval }) : t("soon");
                    }
                    st.answered = true; st.ease = ease; st.label = label;
                    p.reviewTick(st, "answer", ease);
                    // 答「重来」：隔三张再出来一次，趁热再想一遍（只再来一次）
                    if (ease === 1 && st.it && !st.it.again && this.walkQueue) {
                        this.walkQueue.splice(Math.min(3, this.walkQueue.length), 0, { ...st.it, again: true });
                        this.updateLeft();
                    }
                    row.empty();
                    el.removeClass("is-off"); el.addClass("is-done");
                    el.setText(label);
                    // 答对了放小烟花 + 往上走的提示音；答错了只给一记低沉的。连着答对，提示音一次比一次高，三连起飘一个「×N」
                    const good = ease >= 3;
                    this.combo = good ? (this.combo || 0) + 1 : ease === 1 ? 0 : this.combo || 0;
                    if (p.settings.fxAnim) FX.burst(rect, good);
                    if (p.settings.fxSound) good ? FX.up(fxVol(p.settings), (this.combo - 1) * 2) : FX.down(fxVol(p.settings));
                    if (good && this.combo >= 3 && p.settings.fxAnim) FX.float(rect, `×${this.combo}`);
                    setTimeout(() => st.done?.(), 900);   // 让人看一眼结果，再收走
                    // 核对用时有没有记上：AnkiConnect 自动更新后补丁会被覆盖，用时又变回约 0 秒
                    if (!MOBILE && p.settings.durationCheck) {
                        try {
                            const rv = (await p.anki("getReviewsOfCards", { cards: [st.card.cardId] }))?.[String(st.card.cardId)] || [];
                            const last = rv.reduce((m, x) => (!m || x.id > m.id ? x : m), null);
                            if (last && last.time < 1000) el.setText(el.getText() + t("durWarn"));
                        } catch (e) { /* 查不到就算了 */ }
                    }
                } catch (e) {
                    row.querySelectorAll("button").forEach((x) => (x.disabled = false));
                    new Notice(t("notRecorded", { e: e.message || e }));
                }
            };
        }
    }
}

// ---------- 插件 ----------
module.exports = class CardWalk extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULTS, await this.loadData());
        this.local = this.loadLocal();
        this.relay = new Relay(this);
        this.devices = {}; this.ans = {}; this.goalAll = {};
        this.syncState = this.relay.on ? { connecting: true } : { off: true };
        if (MOBILE) { const c = this.lsGet("snap"); if (c?.v && c.snap) this.setSnap(c.snap, c.v); }
        this.registerView(VIEW, (leaf) => new CardView(leaf, this));
        this.registerHoverLinkSource(VIEW, { display: t("viewTitle"), defaultMod: true });
        this.addSettingTab(new CWSettings(this.app, this));
        this.addRibbonIcon("layers", t("open"), () => this.openView(true));
        this.addCommand({ id: "open", name: t("open"), callback: () => this.openView(true) });
        this.addCommand({ id: "sync-now", name: t("syncNow"), callback: () => this.poll(true) });
        this.app.workspace.onLayoutReady(async () => {
            const today = M().format("YYYY-MM-DD");
            if (this.settings.autoOpen && this.local.lastAutoOpen !== today) {
                this.local.lastAutoOpen = today; this.saveLocal();
                await this.openView(false);
            }
            this.startSync();
            // 没挂学科双链的卡按意思归学科（借第二大脑的向量）：启动 30 秒后一次，之后每 30 分钟
            if (!MOBILE) {
                setTimeout(() => this.classifySubjects().catch((e) => console.warn("[card-walk] 归学科", e)), 30000);
                this.registerInterval(window.setInterval(() => this.classifySubjects().catch((e) => console.warn("[card-walk] 归学科", e)), 30 * 60 * 1000));
            }
        });
    }
    onunload() {
        if (this.syncTimer) this.ankiSync();   // 还有没同步的作答：关掉 / 重载前补一次（不等结果）
        if (this.reviewTimer) this.flushReview();
    }
    async saveSettings() { await this.saveData(this.settings); }
    // ----- 只属于这台设备的东西：设备名、每天刷了几张、上次选的分类和范围、手机上的作答。存在本机（localStorage），不进库，不走 iCloud -----
    lsGet(k) { try { return this.app.loadLocalStorage ? this.app.loadLocalStorage("card-walk-" + k) : JSON.parse(window.localStorage.getItem("card-walk-" + k) || "null"); } catch (e) { return null; } }
    lsSet(k, v) { try { if (this.app.saveLocalStorage) this.app.saveLocalStorage("card-walk-" + k, v); else window.localStorage.setItem("card-walk-" + k, JSON.stringify(v)); } catch (e) { console.warn("[card-walk] 本机存储", e); } }
    loadLocal() {
        const l = Object.assign({ goalHist: {}, walkMode: "main", walkRange: "all", lastAutoOpen: "", mine: [] }, this.lsGet("local") || {});
        if (!l.dev) l.dev = (MOBILE ? "m-" : "d-") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (!l.name) l.name = MOBILE ? (Platform.isIosApp ? (Platform.isTablet ? "iPad" : "iPhone") : "Android") : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows" : "Linux";
        this.lsSet("local", l);
        return l;
    }
    saveLocal() { this.lsSet("local", this.local); }
    async openView(reveal) {
        let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
        if (!leaf) { leaf = MOBILE ? this.app.workspace.getLeaf("tab") : this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW, active: reveal }); }
        else { await leaf.loadIfDeferred?.(); if (leaf.view?.render) await leaf.view.render(); }
        if (reveal) this.app.workspace.revealLeaf(leaf);
    }
    views() { return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).filter((v) => v instanceof CardView); }
    viewClosed() {
        if (this.syncTimer) this.ankiSync();
        if (this.reviewTimer) this.flushReview();
        this.poll();
    }

    // ---------- 同步 ----------
    // 节奏：手机上面板开着、App 在前台时每 5 秒一次；电脑在手机最近 3 分钟有心跳时每 5 秒一次，手机半小时内来过每 30 秒，否则每 60 秒
    //   （Upstash 免费档每月 50 万次命令：电脑 24 小时开着、每 30 秒一次就会超，所以手机很久没来时放慢）
    // 后台窗口里 setTimeout / setInterval 会被压到约一分钟一次：用 Web Worker 里的定时器发消息唤醒（Worker 不受这条限制）
    startSync() {
        const tick = () => this.loopTick();
        try {
            const url = URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 2500)"], { type: "text/javascript" }));
            const w = new Worker(url);
            w.onmessage = tick;
            this.register(() => { w.terminate(); URL.revokeObjectURL(url); });
        } catch (e) { console.warn("[card-walk] Worker 定时器起不来，只用普通定时器", e); }
        // 兜底：Worker 被拦了也会静默不发消息。两个一起跑不冲突，loopTick 自己看间隔
        this.registerInterval(window.setInterval(tick, 5000));
        this.registerDomEvent(document, "visibilitychange", () => { if (!document.hidden) this.poll(); });
        this.poll();
    }
    loopTick() {
        if (!this.relay.on || this.polling) return;
        const since = Date.now() - (this.lastPollAt || 0);
        if (MOBILE) {
            if (document.hidden) return;
            if ((this.views().length || this.outbox().length) && since >= 4800) this.poll();
            return;
        }
        if (since >= (this.phoneActive() ? 4800 : this.phoneActive(30 * 60 * 1000) ? 29800 : 59800)) this.poll();
    }
    phoneActive(within = PHONE_ACTIVE_MS) { const now = Date.now(); return Object.values(this.devices).some((d) => d.kind === "mobile" && now - d.at < within); }
    devName(id) { return id === this.local.dev ? this.local.name : this.devices[id]?.name || id; }
    async poll(loud) {
        if (!this.relay.on) { this.syncState = { off: true }; this.refreshSyncUI(); return; }
        if (this.polling) return;
        this.polling = true;
        let changed = false, err = null;
        try {
            const now = Date.now(), dev = this.local.dev;
            if (!MOBILE) this.ankiUp = await this.anki("version").then(() => true, () => false);
            const hb = { name: this.local.name, kind: MOBILE ? "mobile" : "desktop", at: now, v: this.manifest.version };
            if (!MOBILE) { hb.anki = this.ankiUp; hb.checked = this.snapCheckedAt || 0; }
            const cmds = [["HSET", K.hb, dev, JSON.stringify(hb)]];
            const goal = JSON.stringify(this.local.goalHist || {});
            if (goal !== this.goalPushed) cmds.push(["HSET", K.goal, dev, goal]);
            // 手机上还没确认到了中转站的作答：用 HSETNX 补推（已经在了就不动，免得把电脑改成 applied 的又改回 queued）
            const out = MOBILE ? this.outbox() : [];
            for (const x of out) cmds.push(["HSETNX", K.ans, x.id, JSON.stringify({ cid: x.cid, ease: x.ease, dur: x.dur, at: x.at, dev, state: "queued" })]);
            const iHb = cmds.push(["HGETALL", K.hb]) - 1, iV = cmds.push(["GET", K.snapv]) - 1, iAns = cmds.push(["HGETALL", K.ans]) - 1, iGoal = cmds.push(["HGETALL", K.goal]) - 1;
            const r = await this.relay.run(cmds);
            this.goalPushed = goal;
            if (out.length) this.markUploaded(out.map((x) => x.id));
            this.devices = parseHash(r[iHb]);
            this.ans = parseHash(r[iAns]);
            this.goalAll = parseHash(r[iGoal]);
            if (MOBILE) {
                const v = r[iV];
                if (v && v !== this.snapV) {
                    const [raw] = await this.relay.run([["GET", K.snap]]);
                    if (raw) { this.setSnap(JSON.parse(raw), v); this.lsSet("snap", { v, snap: JSON.parse(raw) }); changed = true; }
                }
                this.pruneMine();
            } else if (this.ankiUp) {
                if (await this.applyQueued()) changed = true;
            }
            this.syncState = { ok: true, at: Date.now() };
        } catch (e) {
            err = e;
            this.syncState = { ok: false, err: String(e.message || e).slice(0, 80), at: Date.now() };
            if (loud) new Notice(t("err", { e: this.syncState.err }));
        } finally {
            this.polling = false;
            this.lastPollAt = Date.now();
        }
        if (!err && !MOBILE && this.ankiUp) await this.maybeSnapshot().catch((e) => console.warn("[card-walk] 推快照", e));
        if (changed) { this.dueCache = null; this.views().forEach((v) => v.recheck()); }
        this.refreshSyncUI();
    }
    refreshSyncUI() {
        for (const v of this.views()) { v.renderSync(); v.updateGoal(); }
    }
    // ----- 手机：作答先记本机，当场推中转站；推不上就留在本机，下次轮询补推 -----
    outbox() { return (this.local.mine || []).filter((x) => !x.up); }
    markUploaded(ids) { const s = new Set(ids); for (const x of this.local.mine || []) if (s.has(x.id)) x.up = true; this.saveLocal(); }
    pruneMine() {
        // 进了 Anki / 被拒的、超过 3 天的不留；中转站上已经删掉（7 天清理）的也不留
        const cut = Date.now() - 3 * 864e5;
        const before = this.local.mine.length;
        this.local.mine = this.local.mine.filter((x) => !x.up || x.at > cut || (this.ans[x.id] && !["applied", "rejected"].includes(this.ans[x.id].state)));
        if (this.local.mine.length !== before) this.saveLocal();
    }
    async recordAnswer(cid, ease, dur) {
        const x = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, cid, ease, dur, at: Date.now(), up: false };
        (this.local.mine ||= []).push(x);
        this.saveLocal();
        try {
            await this.relay.run([["HSETNX", K.ans, x.id, JSON.stringify({ cid, ease, dur, at: x.at, dev: this.local.dev, state: "queued" })]]);
            this.markUploaded([x.id]);
            this.ans[x.id] = { cid, ease, dur, at: x.at, dev: this.local.dev, state: "queued" };
            this.syncState = { ok: true, at: Date.now() };
        } catch (e) { this.syncState = { ok: false, err: String(e.message || e).slice(0, 80), at: Date.now() }; }
        this.refreshSyncUI();
        return x.up;
    }
    // 这几张卡在快照之后已经在某台设备上答过：返回那台设备的 id（这台的优先）
    answeredSince(cids) {
        const at = this.snap?.at || 0;
        if ((this.local.mine || []).some((x) => x.at > at && cids.includes(x.cid))) return this.local.dev;
        const hit = Object.values(this.ans).find((x) => x.at > at && x.state !== "rejected" && cids.includes(x.cid));
        return hit ? hit.dev : null;
    }
    // 电脑上：这几张卡在中转站上还有没补进 Anki 的作答
    pendingFor(cids) { return Object.values(this.ans).find((x) => (x.state === "queued" || x.state === "applying") && cids.includes(x.cid)) || null; }
    setSnap(raw, v) {
        this.snap = { ...raw, due: new Set(raw.due || []), new: new Set(raw.new || []), learn: new Set(raw.learn || []), notes: raw.notes || {}, subj: raw.subj || {} };
        this.snapV = v;
        this.reviewDaysCache = null;
    }
    // 最近的作答（今天 + 还没走完三步的），新的在前；手机上还带着没上传的
    recentAnswers() {
        const day = M().startOf("day").valueOf();
        const out = new Map();
        for (const [id, x] of Object.entries(this.ans)) if (x.at >= day || !["applied", "rejected"].includes(x.state)) out.set(id, { id, ...x });
        for (const x of this.local.mine || []) if (!out.has(x.id) && (x.at >= day || !x.up)) out.set(x.id, { id: x.id, cid: x.cid, ease: x.ease, at: x.at, dev: this.local.dev, state: x.up ? "queued" : "local" });
        return [...out.values()].sort((a, b) => b.at - a.at);
    }
    // ----- 电脑：把中转站上排队的作答按先后写进 Anki，标上结果 -----
    async applyQueued() {
        const now = Date.now(), dev = this.local.dev;
        const list = Object.entries(this.ans).map(([id, x]) => ({ id, ...x }));
        const results = [];
        const todo = list.filter((x) => x.state === "queued");
        // 标了 applying 却超过 5 分钟没下文（写到一半崩了）：标完之后 Anki 里有这张卡的复习记录就算写进去了，没有再补
        for (const x of list.filter((x) => x.state === "applying" && now - (x.claimAt || 0) > 5 * 60 * 1000)) {
            const rv = (await this.anki("getReviewsOfCards", { cards: [x.cid] }))?.[String(x.cid)] || [];
            if (rv.some((r) => r.id >= x.claimAt)) results.push({ ...x, state: "applied", doneAt: now });
            else todo.push(x);
        }
        // 进了 Anki / 被拒超过 7 天的删掉
        const old = list.filter((x) => ["applied", "rejected"].includes(x.state) && now - (x.doneAt || x.at) > 7 * 864e5).map((x) => x.id);
        if (!todo.length && !results.length && !old.length) return false;
        todo.sort((a, b) => a.at - b.at);
        const enc = ({ id, ...x }) => JSON.stringify(x);
        if (todo.length) await this.relay.run(todo.map((x) => ["HSET", K.ans, x.id, enc({ ...x, state: "applying", by: dev, claimAt: now })]));
        for (const x of todo) {
            try {
                // 旧版手机端记的作答没带用时
                if (!(await this.answerCard(x.cid, x.ease, x.dur || 0))) { results.push({ ...x, state: "rejected", err: t("cardDeleted"), doneAt: Date.now() }); continue; }
                let ivl = 0;
                try { const [info] = await this.anki("cardsInfo", { cards: [x.cid] }); if (info?.queue === 2) ivl = info.interval; } catch (e) { /* 只是少个天数 */ }
                results.push({ ...x, state: "applied", ivl, doneAt: Date.now() });
            } catch (e) {
                // Anki 中途关了：放回队列，下次再补
                results.push({ ...x, state: "queued", claimAt: undefined });
                break;
            }
        }
        for (const x of todo) if (!results.some((r) => r.id === x.id)) results.push({ ...x, state: "queued", claimAt: undefined });
        const cmds = results.map((x) => ["HSET", K.ans, x.id, enc(x)]);
        if (old.length) cmds.push(["HDEL", K.ans, ...old]);
        await this.relay.run(cmds);
        for (const x of results) this.ans[x.id] = (({ id, ...y }) => y)(x);
        for (const id of old) delete this.ans[id];
        if (results.some((x) => x.state === "applied")) { this.scheduleAnkiSync(); this.snapCheckedAt = 0; this.reviewDaysCache = null; }
        return results.length > 0;
    }
    // ----- 电脑：Anki 快照。手机在刷时每 15 秒核对一次，平时每 10 分钟；内容变了才推，版本号跟着变 -----
    snapSoon() { if (MOBILE || !this.relay.on) return; clearTimeout(this.snapTimer); this.snapTimer = setTimeout(() => { this.snapCheckedAt = 0; this.maybeSnapshot().then(() => this.refreshSyncUI(), () => {}); }, 2000); }
    async maybeSnapshot() {
        if (MOBILE || !this.relay.on || this.snapping) return;
        const now = Date.now();
        if (now - (this.snapCheckedAt || 0) < (this.phoneActive() ? 15000 : 10 * 60 * 1000)) return;
        this.snapping = true;
        try {
            const snap = await this.buildSnapshot();
            const body = JSON.stringify(snap), sig = fnv(body);
            if (sig !== this.snapSig) {
                const v = String(now);
                await this.relay.run([["SET", K.snap, JSON.stringify({ ...snap, at: now })], ["SET", K.snapv, v]]);
                this.snapSig = sig;
            }
            this.snapCheckedAt = now;
        } finally { this.snapping = false; }
    }
    async buildSnapshot() {
        const pool = await this.walkPool();
        const nids = [...new Set([...pool.card, ...pool.cloze].map((it) => this.nidOf(it)).filter(Boolean).map(String))];
        const known = (this.noteCards ||= {});
        const miss = nids.filter((n) => !known[n]).map(Number);
        // 笔记 → 卡号只在第一次 / 新卡时查（一批 200 条）
        for (let i = 0; i < miss.length; i += 200) {
            const info = await this.anki("notesInfo", { notes: miss.slice(i, i + 200) });
            for (const x of info || []) if (x?.noteId) known[String(x.noteId)] = x.cards || [];
        }
        const notes = {}, mineCids = new Set();
        for (const n of nids) if (known[n]) { notes[n] = known[n]; known[n].forEach((c) => mineCids.add(c)); }
        const [due, nw, learn] = await Promise.all(["is:due -is:suspended -is:buried", "is:new -is:suspended -is:buried", "is:learn -is:suspended -is:buried"].map((q) => this.anki("findCards", { query: q })));
        let byDay = {};
        try { byDay = Object.fromEntries((await this.anki("getNumCardsReviewedByDay")).slice(0, 60)); } catch (e) { /* 旧版 AnkiConnect 没有 */ }
        const own = (a) => a.filter((c) => mineCids.has(c)).sort((x, y) => x - y);
        const subj = this.lsGet("subj") || {};
        return { v: 1, notes, due: own(due), new: own(nw), learn: own(learn), byDay, subj: subj.map || {}, subjSig: subj.sig || "" };
    }
    // 状态条的一行结论 + 下面一行补充；level：ok 绿 / warn 黄 / bad 红 / off 灰
    syncView() {
        const s = this.syncState || {}, now = Date.now();
        if (!this.relay.on) return { level: "off", text: MOBILE ? t("offM") : t("offD") };
        if (s.connecting) return { level: "off", text: t("connecting") };
        const sub = MOBILE ? this.mobileSummary() : "";
        if (s.ok === false) {
            const local = MOBILE ? this.outbox().length : 0;
            return { level: "bad", text: t("err", { e: s.err }) + (local ? t("errLocal", { n: local }) : ""), sub };
        }
        if (!MOBILE) {
            if (!this.ankiUp) {
                const waiting = Object.values(this.ans).filter((x) => x.state === "queued").length;
                return { level: "warn", text: t("dAnkiDown") + (waiting ? t("dWaiting", { n: waiting }) : "") };
            }
            const day = M().startOf("day").valueOf();
            const fromPhone = Object.values(this.ans).filter((x) => x.state === "applied" && x.dev !== this.local.dev && (x.doneAt || 0) >= day).length;
            const phones = Object.values(this.devices).filter((d) => d.kind === "mobile").sort((a, b) => b.at - a.at);
            const extra = fromPhone ? t("dFromPhone", { n: fromPhone }) : "";
            if (phones[0] && now - phones[0].at < PHONE_ACTIVE_MS) return { level: "ok", text: t("dPhone", { dev: phones[0].name, ago: ago(phones[0].at) }), sub: extra };
            return { level: "ok", text: t("dIdle", { ago: ago(this.snapCheckedAt || s.at) }) + (phones[0] ? t("dNoPhone", { ago: ago(phones[0].at) }) : ""), sub: extra };
        }
        const pcs = Object.values(this.devices).filter((d) => d.kind === "desktop").sort((a, b) => b.at - a.at);
        const pc = pcs[0];
        if (!pc) return { level: "warn", text: t("mNever"), sub };
        if (now - pc.at > ONLINE_MS) return { level: "warn", text: t("mOffline", { ago: ago(pc.at) }), sub, hint: t("hintOffline") };
        if (!pc.anki) return { level: "warn", text: t("mNoAnki"), sub, hint: t("hintNoAnki") };
        return { level: "ok", text: t("mLive", { ago: ago(Math.max(pc.checked || 0, this.snap?.at || 0)) }), sub };
    }
    mobileSummary() {
        const day = M().startOf("day").valueOf();
        const mine = (this.local.mine || []).filter((x) => x.at >= day);
        if (!mine.length) return "";
        const st = (x) => (x.up ? this.ans[x.id]?.state || "queued" : "local");
        const a = mine.filter((x) => st(x) === "applied").length, rj = mine.filter((x) => st(x) === "rejected").length, l = mine.filter((x) => st(x) === "local").length;
        return t("mToday", { n: mine.length, a, w: mine.length - a - rj - l }) + (l ? t("mLocal", { n: l }) : "") + (rj ? t("mRejected", { n: rj }) : "");
    }

    // ---------- 卡池 ----------
    excludeList() { return split(this.settings.excludeFolders); }
    privateRe() {
        const names = split(this.settings.privateLinks);
        return names.length ? new RegExp(`\\[\\[(?:[^\\]|]*/)?(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:[|#\\]])`) : null;
    }
    langOn() { return !!(String(this.settings.langPattern).trim() || this.settings.langGuess); }
    // 日记：文件夹和日期格式跟核心「日记」插件（设置里填了文件夹就用填的）
    dailyCfg() {
        const o = this.app.internalPlugins?.getPluginById?.("daily-notes")?.instance?.options || {};
        return { folder: String(this.settings.journalFolder || o.folder || "").replace(/^\/|\/$/g, ""), format: o.format || "YYYY-MM-DD" };
    }
    journalDate(file) {
        const { folder, format } = this.dailyCfg();
        if (folder && !file.path.startsWith(folder + "/")) return null;
        const d = moment(file.basename, format, true);
        return d.isValid() ? d : null;
    }
    // 卡池：#card 卡片、==挖空== 所在的列表项（连同子项）。全库扫一遍要读文件，结果留 10 分钟
    async walkPool() {
        if (this.pool && Date.now() - this.pool.at < 10 * 60 * 1000) return this.pool;
        const mc = this.app.metadataCache;
        const ex = this.excludeList(), priv = this.privateRe();
        const isEx = (p) => ex.some((x) => p === x || p.startsWith(x.replace(/\/?$/, "/")));
        const pool = { card: [], cloze: [], at: Date.now() };
        let langRe = null;
        try { langRe = String(this.settings.langPattern).trim() ? new RegExp(this.settings.langPattern) : null; } catch (e) { console.warn("[card-walk] 语言类规则写错了", e); }
        const langExcept = new Set(split(this.settings.langExcept));
        const langName = (n) => !!langRe && langRe.test(n) && !langExcept.has(n);
        const knowledge = split(this.settings.knowledgeFolders).map((x) => x.replace(/\/?$/, "/"));
        const CLOZE = /==[^=\s][^=\n]*==|\{\{c\d+::/;
        const CARD = /#(card|flashcard|reversed)\b/i;
        let n = 0;
        for (const f of this.app.vault.getMarkdownFiles()) {
            if (isEx(f.path)) continue;
            if (++n % 50 === 0) await sleep(0);   // 让出界面
            const c = mc.getFileCache(f) || {};
            const items = c.listItems || [];
            const L = (await this.app.vault.cachedRead(f)).split("\n");
            if (!L.some((l) => CARD.test(l) || CLOZE.test(l))) continue;
            // 这块是哪天记的：日记按日记的日期，别的笔记按文件建立的时间
            const jd = this.journalDate(f), born = jd ? jd.valueOf() : f.stat.ctime;
            const skip = new Set();
            for (const sec of c.sections || []) if (sec.type === "code" || sec.type === "yaml") for (let i = sec.position.start.line; i <= sec.position.end.line; i++) skip.add(i);
            // 第 k 行所在的列表项，连同它的子项；不在列表里就取那一段。先一遍算好每行属于谁、每项的子树到哪一行
            const owner = new Array(L.length).fill(null), endOf = listEnds(items);
            for (const sec of c.sections || []) for (let i = sec.position.start.line; i <= sec.position.end.line && i < L.length; i++) owner[i] = { s: sec.position.start.line, e: sec.position.end.line };
            for (const it of items) {
                const st = it.position.start.line;
                for (let i = st; i <= it.position.end.line && i < L.length; i++) owner[i] = st;
            }
            const blockAt = (k) => { const o = owner[k]; if (o == null) return { s: k, e: k }; return typeof o === "number" ? { s: o, e: endOf.get(o) } : o; };
            const linksAt = new Map();
            for (const l of c.links || []) { const k = l.position.start.line; if (!linksAt.has(k)) linksAt.set(k, []); linksAt.get(k).push(l.link.split("|")[0].split("#")[0].trim()); }
            const lineItem = new Map(items.map((x) => [x.position.start.line, x]));
            const chain = (s0) => { const out = [s0]; let x = lineItem.get(s0), d = 0; while (x && x.parent >= 0 && x.parent !== x.position.start.line && d++ < 30) { out.push(x.parent); x = lineItem.get(x.parent); } return out; };
            // 语言类：卡片本身、上层或下层链到符合规则的页；langGuess 开着时，挖掉的全是外文生词 / 英文句子的挖空也算
            const isLang = (kind, s0, e0, text) => {
                const lines = [...chain(s0)];
                for (let k = s0 + 1; k <= e0; k++) lines.push(k);
                const names = lines.flatMap((k) => linksAt.get(k) || []);
                if (names.some(langName)) return true;
                if (!this.settings.langGuess || kind !== "cloze") return false;
                if (knowledge.length && names.some((x) => { const p = mc.getFirstLinkpathDest(x, f.path)?.path; return p && knowledge.some((k) => p.startsWith(k)); })) return false;
                const blanks = [...text.matchAll(/==([^=\n]+)==|\{\{c\d+::([^}]*)\}\}/g)].map((m) => (m[1] ?? m[2]).trim());
                const foreign = (x) => /^[A-Za-z぀-ヿ][A-Za-z぀-ヿ\s'’.,!?-]*$/.test(x) || (/[぀-ヿ]/.test(x) && /^[぀-ヿ一-鿿\s]+$/.test(x));
                if (!blanks.length || !blanks.every(foreign)) return false;
                const first = plain(text.split("\n")[0]);
                const latin = (first.match(/[A-Za-z]/g) || []).length, cjk = (first.match(/[一-鿿]/g) || []).length;
                const sentence = (first.match(/[A-Za-z]+ +[A-Za-z]+/g) || []).length >= 2;
                return !names.length || (latin > cjk && sentence);
            };
            const ctxOf = (s0) => chain(s0).slice(1).reverse().map((k) => ({ line: k, text: (L[k] || "").replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "").replace(/(^|\s)\^[\w-]+\s*$/, "").replace(/\s*#(card|flashcard|reversed)\b/gi, "").trim() })).filter((x) => x.text);
            const seen = new Set(), taken = [];
            const add = (kind, k) => {
                const b = blockAt(k);
                // 和 Flashcards 一样：已经包含在上层卡片 / 挖空里的子项不再单算一张
                if (seen.has(b.s) || taken.some((r) => b.s > r.s && b.s <= r.e)) return;
                seen.add(b.s);
                taken.push(b);
                const text = L.slice(b.s, b.e + 1).join("\n");
                if (plain(text).length < 6 || (priv && priv.test(text))) return;
                const links = [...chain(b.s)];
                for (let k2 = b.s + 1; k2 <= b.e; k2++) links.push(k2);
                pool[kind].push({ kind, file: f, line: b.s, end: b.e, text, lang: isLang(kind, b.s, b.e, text), ctx: ctxOf(b.s), at: born,
                    links: [...new Set(links.flatMap((k2) => linksAt.get(k2) || []).map((x) => x.split("/").pop().toLowerCase()))] });
            };
            // #card 按文字找：「自己#card」这种前面没空格的，Obsidian 不认成标签，但 Flashcards 照样制卡
            L.forEach((line, k) => { if (!skip.has(k) && CARD.test(line)) add("card", k); });
            L.forEach((line, k) => { if (!skip.has(k) && CLOZE.test(line) && !CARD.test(line)) add("cloze", k); });
        }
        this.pool = pool;
        return pool;
    }
    // ----- 学科 -----
    subjects() {
        if (this._subsText !== this.settings.subjects) { this._subsText = this.settings.subjects; this._subs = parseSubjects(this.settings.subjects); }
        return this._subs;
    }
    // 从卡片里推荐学科：候选是卡片本身或母块链到的页、卡片所在的顶层文件夹；每轮挑覆盖「还没归类」的卡最多的那个，覆盖太少就停，最多 8 门
    async suggestSubjects() {
        const pool = await this.walkPool(), mc = this.app.metadataCache, used = this.subjects();
        const items = [...pool.card, ...pool.cloze].filter((it) => !it.lang);
        const covered = new Set(items.filter((it) => this.ruleSubject(it)));
        const daily = this.dailyCfg().folder.split("/")[0];
        // 没建页面的双链在卡池里是小写：从「未解析的链接」里找回原来的大小写
        const caseOf = new Map();
        for (const m of Object.values(mc.unresolvedLinks || {})) for (const k of Object.keys(m)) { const n = k.split("/").pop(); caseOf.set(n.toLowerCase(), n); }
        const cand = new Map();
        const add = (key, name, line, it) => {
            if (/[:：|,，]/.test(name)) return;   // 学科那一行的分隔符，名字里有就没法写
            let c = cand.get(key);
            if (!c) cand.set(key, (c = { line, cards: new Set() }));
            c.cards.add(it);
        };
        for (const it of items) {
            for (const l of it.links || []) {
                if (used.some((x) => x.links.has(l))) continue;
                const f = mc.getFirstLinkpathDest(l, it.file.path);
                if (f && this.journalDate(f)) continue;   // 日记页不当学科
                const name = f?.basename || caseOf.get(l) || l;
                add("l:" + l, name, `${name}：${name}`, it);
            }
            const top = it.file.path.includes("/") ? it.file.path.split("/")[0] : "";
            if (top && top !== daily && !used.some((x) => x.folders.includes(top))) add("f:" + top, top, `${top}：| ${top}`, it);
        }
        const out = [], min = Math.max(3, Math.ceil(items.length * 0.02));
        while (out.length < 8) {
            let best = null, gain = 0;
            for (const [k, c] of cand) { let g = 0; for (const it of c.cards) if (!covered.has(it)) g++; if (g > gain) { gain = g; best = k; } }
            if (!best || gain < min) break;
            const c = cand.get(best);
            out.push(c.line);
            for (const it of c.cards) covered.add(it);
            cand.delete(best);
        }
        return out;
    }
    ruleSubject(it) {
        for (const x of this.subjects()) {
            if (it.links?.some((n) => x.links.has(n))) return x.name;
            if (x.folders.some((d) => it.file.path.startsWith(d + "/"))) return x.name;
        }
        return null;
    }
    subjectKey(it) { return fnv(cardText(it.text)); }
    subjectOf(it) {
        const sig = fnv(this.settings.subjects);
        if (it._subjFor === sig && it._subjSnap === this.snap) return it._subj;
        let s = this.ruleSubject(it);
        if (!s) {
            // 按意思归的结果：电脑上存在本机，手机上从快照里拿
            const m = MOBILE ? (this.snap?.subjSig === sig ? this.snap.subj : null) : (this._subjMap ||= this.lsGet("subj"))?.sig === sig ? this._subjMap.map : null;
            s = m?.[this.subjectKey(it)] || null;
        }
        it._subj = s || t("other"); it._subjFor = sig; it._subjSnap = this.snap;
        return it._subj;
    }
    // 没挂上学科双链、也不在学科文件夹里的卡：找 7 张最像的已归类的卡投票，最像的那张不够像（余弦 < 0.62）就算「其他」
    // 向量借第二大脑的（任何提供 embedCached(texts) 的插件都行）；没装就只按规则归
    async classifySubjects() {
        if (MOBILE || !this.subjects().length) return;
        const sb = this.app.plugins.plugins[SB_ID] || Object.values(this.app.plugins.plugins).find((x) => typeof x?.embedCached === "function");
        if (typeof sb?.embedCached !== "function") return;
        const sig = fnv(this.settings.subjects);
        let saved = this.lsGet("subj");
        if (!saved || saved.sig !== sig) saved = { sig, map: {} };
        const pool = await this.walkPool();
        const items = [...pool.card, ...pool.cloze].filter((it) => !it.lang);
        const labeled = items.filter((it) => this.ruleSubject(it));
        const todo = items.filter((it) => !this.ruleSubject(it) && !(this.subjectKey(it) in saved.map));
        if (!todo.length || !labeled.length) return;
        const textOf = (it) => (it.ctx.map((c) => c.text).join(" › ") + "\n" + plain(cardText(it.text))).slice(0, 1200);
        const L = await sb.embedCached(labeled.map(textOf)), U = await sb.embedCached(todo.map(textOf));
        if (!L || !U) return;
        const lab = labeled.map((it) => this.ruleSubject(it));
        U.forEach((u, i) => {
            const key = this.subjectKey(todo[i]);
            if (!u) return;
            const top = [];
            for (let j = 0; j < L.length; j++) {
                const v = L[j]; if (!v) continue;
                let d = 0; for (let k = 0; k < u.length; k++) d += u[k] * v[k];
                if (top.length < 7 || d > top[top.length - 1][0]) { top.push([d, lab[j]]); top.sort((a, b) => b[0] - a[0]); if (top.length > 7) top.pop(); }
            }
            if (!top.length || top[0][0] < 0.62) { saved.map[key] = ""; return; }
            const vote = {};
            for (const [d, name] of top) vote[name] = (vote[name] || 0) + d;
            saved.map[key] = Object.entries(vote).sort((a, b) => b[1] - a[1])[0][0];
        });
        this.lsSet("subj", saved);
        this._subjMap = saved;
        this.snapSoon();
    }
    // 把一张卡变回普通文字：卡片去掉 #card（及 #reversed 等制卡标签），挖空去掉 ==…== / {{cN::…}} / {N:…} 的标记，文字原样留着
    // 改之前核对原文没变；成功后给一个可以撤销的提示
    async uncard(it) {
        const unCloze = (s) => s.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, "$1").replace(/\{(\d+):([^{}\n]*?)\}/g, "$2").replace(/==([^=\n]+)==/g, "$1");
        const transform = (text) => {
            const L = text.split("\n");
            if (it.kind === "card") {
                const k = L.findIndex((l) => /#(card|flashcard|reversed)(-reminder|-reverse|\/reverse)?(?![\w-])/i.test(l));
                if (k < 0) return null;
                L[k] = L[k].replace(/\s*#(card|flashcard|reversed)(-reminder|-reverse|\/reverse)?(?![\w-])/gi, "");
                // 答案里的 ==高亮== 原来被这张卡包着，去掉 #card 后会被 Flashcards 当成新的挖空卡，一起去掉
                return unCloze(L.join("\n"));
            }
            const out = unCloze(text);
            return out === text ? null : out;
        };
        const swap = async (from, to) => {
            let ok = false;
            await this.app.vault.process(it.file, (data) => {
                const L = data.split("\n"), n = from.split("\n").length;
                if (L.slice(it.line, it.line + n).join("\n") !== from) return data;
                L.splice(it.line, n, ...to.split("\n"));
                ok = true;
                return L.join("\n");
            });
            return ok;
        };
        const next = transform(it.text);
        if (next == null) { new Notice(t("noMark")); return false; }
        if (!(await swap(it.text, next))) { new Notice(t("changed")); return false; }
        this.pool = null;
        const frag = createFragment((f) => {
            f.appendText(t("uncarded", { f: it.file.basename }));
            const b = f.createEl("button", { text: t("undo") });
            b.onclick = async () => { if (await swap(next, it.text)) { this.pool = null; new Notice(t("undone")); } else new Notice(t("cantUndo")); };
        });
        new Notice(frag, 10000);
        return true;
    }

    // ---------- 每日目标和复习计时 ----------
    goalTarget() { return Math.max(1, Number(this.settings.reviewGoal) || 20); }
    // 某天刷了几张：这台设备的 + 中转站上别的设备的
    dayCount(d) {
        let n = this.local.goalHist?.[d] || 0;
        for (const [dev, h] of Object.entries(this.goalAll || {})) if (dev !== this.local.dev) n += h?.[d] || 0;
        return n;
    }
    goalDone() { return this.dayCount(M().format("YYYY-MM-DD")); }
    goalTick() {
        const day = M().format("YYYY-MM-DD"), goal = this.goalTarget(), before = this.goalDone();
        const h = (this.local.goalHist ||= {});
        h[day] = (h[day] || 0) + 1;
        const cut = M().subtract(60, "days").format("YYYY-MM-DD");
        for (const d of Object.keys(h)) if (d < cut) delete h[d];
        this.saveLocal();
        const views = this.views();
        for (const v of views) { v.updateGoal(); v.bumpGoal(); }
        if (before < goal && before + 1 >= goal) {
            const bar = views.map((v) => v.goalEl).find((g) => g?.isConnected);
            if (this.settings.fxAnim && bar) setTimeout(() => FX.confetti(bar.getBoundingClientRect()), 250);
            if (this.settings.fxSound) setTimeout(() => FX.goal(fxVol(this.settings)), 250);
            new Notice(t("goalDone", { goal }));
        }
    }
    // 最近 14 天每天在 Anki 里复习了几张（5 分钟内复用）：电脑上问 Anki，手机上看快照
    async reviewDays() {
        const c = this.reviewDaysCache;
        if (c && Date.now() - c.at < 5 * 60 * 1000) return !!c.map;
        if (this.reviewDaysLoading) return false;
        this.reviewDaysLoading = true;
        try {
            if (MOBILE) { this.reviewDaysCache = { at: Date.now(), map: this.snap?.byDay || null }; return !!this.snap; }
            this.reviewDaysCache = { at: Date.now(), map: Object.fromEntries(await this.anki("getNumCardsReviewedByDay")) };
            return true;
        // 失败多半是 Anki 正忙（面板刚打开，几张卡的状态查询在排队，单线程的 AnkiConnect 超了 4 秒）：30 秒后再试，不等 5 分钟
        } catch (e) { this.reviewDaysCache = { at: Date.now() - 4.5 * 60 * 1000, map: null }; return false; }
        finally { this.reviewDaysLoading = false; }
    }
    // 一轮 = 第一次揭开 / 作答到最后一次；最后一次操作 3 分钟后（或关掉面板时）算结束，写一行。先揭开再作答的卡只算一次作答
    // 这张卡又花了多少时间：从上一次操作（或继续计时、打开面板）算到现在，暂停的不算；一张最多 60 秒（和 Anki「最长作答时间」的默认值一样），忘了暂停走开也不会记出离谱的数
    spend(st) {
        if (this.paused) this.setPaused(false);   // 暂停着又揭开 / 作答了：就是回来了
        const now = Date.now();
        st.ms = (st.ms || 0) + Math.max(0, Math.min(now - this.mark, CARD_MAX_MS - (st.ms || 0)));
        this.mark = now;
    }
    reviewTick(st, kind, ease) {
        if (!st.goal) { st.goal = true; this.goalTick(); }
        if (!this.settings.reviewLog) return;
        const s = (this.reviewSession ||= { start: Date.now(), end: Date.now(), answer: 0, again: 0, look: 0, ms: 0 });
        s.ms += (st.ms || 0) - (st.logged || 0); st.logged = st.ms;
        if (kind === "look" && !st.counted) { s.look++; st.counted = "look"; }
        if (kind === "answer" && st.counted !== "answer") {
            if (st.counted === "look") s.look--;
            s.answer++; if (ease === 1) s.again++;
            st.counted = "answer";
        }
        s.end = Date.now();
        clearTimeout(this.reviewTimer);
        this.reviewTimer = setTimeout(() => this.flushReview(), 3 * 60 * 1000);
    }
    // 暂停：这一轮当场记进日记，回来另起一行（不和暂停前那行合并）；点 ▶ 或接着揭开 / 作答就继续
    async setPaused(on) {
        this.paused = on;
        if (!on) this.mark = Date.now();
        for (const v of this.views()) v.updatePause();
        if (on) { await this.flushReview(); this.lastReview = null; }
    }
    // 日记路径和「今天」：装了螺旋日程（nautilus-spiral）就跟它一致（凌晨分界前算前一天），否则按核心「日记」插件的设置
    reviewJournalPath(ts) {
        const ns = this.app.plugins.plugins["nautilus-spiral"];
        if (ns?.today && ns?.journalPath) {
            const cut = ns.settings?.dayCutoff ?? 0, m = moment(ts);
            if (m.hours() * 60 + m.minutes() < cut * 60) m.subtract(1, "day");
            return ns.journalPath(m.startOf("day"));
        }
        const { folder, format } = this.dailyCfg();
        return (folder ? folder + "/" : "") + moment(ts).format(format) + ".md";
    }
    async flushReview() {
        clearTimeout(this.reviewTimer); this.reviewTimer = null;
        const s = this.reviewSession; this.reviewSession = null;
        if (!s || !(s.answer + s.look)) return;
        const path = this.reviewJournalPath(s.start);
        const last = this.lastReview;
        const merge = last && last.path === path && s.start - last.end < 10 * 60 * 1000;
        const hm = (ts) => moment(ts).format("HH:mm");
        const tpl = String(this.settings.reviewLogTemplate || "").trim() || t("logTpl");
        const lineOf = (x) => {
            const mins = Math.max(1, Math.round((x.ms || 0) / 60000));   // 至少一分钟，按时间画图的插件才画得出来
            const parts = [x.answer ? t("logAns", { n: x.answer }) : "", x.again ? t("logAgain", { n: x.again }) : "", x.look ? t("logLook", { n: x.look }) : ""].filter(Boolean);
            return "- " + tpl.replace(/\{start\}/g, hm(x.end - mins * 60 * 1000)).replace(/\{end\}/g, hm(x.end)).replace(/\{n\}/g, String(x.answer + x.look)).replace(/\{detail\}/g, parts.join(" · "));
        };
        const tot = merge ? { start: last.start, end: s.end, answer: last.answer + s.answer, again: last.again + s.again, look: last.look + s.look, ms: (last.ms || 0) + s.ms } : null;
        let wrote = { ...s, line: lineOf(s) };   // 上一行被改过、找不到了，就只记这一轮，免得重复计时
        try {
            let f = this.app.vault.getAbstractFileByPath(path);
            if (!f) f = await this.app.vault.create(path, wrote.line + "\n");
            else await this.app.vault.process(f, (data) => {
                const L = data.split("\n");
                const at = merge ? L.indexOf(last.line) : -1;
                if (at >= 0) { wrote = { ...tot, line: lineOf(tot) }; L[at] = wrote.line; return L.join("\n"); }
                let i = 0;   // 属性区后面的第一行
                if (L[0] === "---") { const e = L.indexOf("---", 1); if (e > 0) i = e + 1; }
                L.splice(i, 0, wrote.line);
                return L.join("\n");
            });
            this.lastReview = { ...wrote, path };
        } catch (e) { console.warn("[card-walk] 复习计时", e); new Notice(t("logFail", { e: e.message || e })); }
    }

    // ---------- Anki（AnkiConnect）----------
    scheduleAnkiSync() {
        if (MOBILE || !this.settings.ankiAutoSync) return;
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.ankiSync(), 3 * 60 * 1000);
    }
    async ankiSync() {
        clearTimeout(this.syncTimer); this.syncTimer = null;
        try {
            // 同步可能要几十秒，不能用 anki() 那个 4 秒超时
            const r = await Promise.race([
                requestUrl({ url: this.settings.ankiUrl, method: "POST", contentType: "application/json", body: JSON.stringify({ action: "sync", version: 6 }) }),
                sleep(120 * 1000).then(() => { throw new Error("timeout"); }),
            ]);
            if (r.json?.error) throw new Error(r.json.error);
        } catch (e) { new Notice(t("ankiSyncFail", { e: e.message || e }), 8000); }
    }
    // 作答写进 Anki，带上用时（秒）；false = Anki 里没这张卡。新版 AnkiConnect（有 /api/v1）的老接口 answerCards 不转用时，
    // 所以先走新接口（scheduling.predict 拿状态令牌，scheduling.answer 带 elapsedMs）；没有新接口的老版用 answerCards 的 duration（要打补丁才认）
    async answerCard(cid, ease, dur) {
        if (this.rpcOn !== false) {
            try {
                const { stateToken } = await this.rpc("scheduling.predict", { cardId: String(cid) });
                await this.rpc("scheduling.answer", { cardId: String(cid), rating: ["again", "hard", "good", "easy"][ease - 1], stateToken, elapsedMs: Math.round(dur * 1000) });
                this.rpcOn = true;
                return true;
            } catch (e) {
                if (e.type === "notFound") return false;
                if (!e.noRpc) throw e;
                this.rpcOn = false;   // 老版 AnkiConnect：这次开着 Obsidian 期间都走老接口
            }
        }
        const ok = await this.anki("answerCards", { answers: [{ cardId: cid, ease, duration: dur }] });
        return !!ok?.[0];
    }
    async rpc(method, params) {
        const r = await Promise.race([
            requestUrl({ url: String(this.settings.ankiUrl).replace(/\/+$/, "") + "/api/v1", method: "POST", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), throw: false }),
            sleep(4000).then(() => { throw new Error("Anki timeout"); }),
        ]);
        let j = null;
        try { j = r.json; } catch (e) { /* 老版回的不是 JSON（404 之类） */ }
        if (j?.jsonrpc !== "2.0") throw Object.assign(new Error("AnkiConnect has no /api/v1"), { noRpc: true });
        if (j.error) throw Object.assign(new Error(j.error.message), { type: j.error.data?.type });
        return j.result;
    }
    async anki(action, params = {}) {
        if (MOBILE) throw new Error("AnkiConnect is desktop only");
        const r = await Promise.race([
            requestUrl({ url: this.settings.ankiUrl, method: "POST", contentType: "application/json", body: JSON.stringify({ action, version: 6, params }) }),
            sleep(4000).then(() => { throw new Error("Anki timeout"); }),
        ]);
        if (r.json?.error) throw new Error(r.json.error);
        return r.json?.result;
    }
    // 块对应的 Anki 笔记：Flashcards 把「块 id → nid」记在笔记属性 flashcards 里；块 id 在块首行末尾，或紧跟在块后面单独一行（^q-xxxx）
    nidOf(it) {
        const c = this.app.metadataCache.getFileCache(it.file) || {};
        const fc = c.frontmatter?.flashcards;
        if (!fc || typeof fc !== "object") return null;
        const end = it.end ?? it.line;
        const cand = [];
        it.text.split("\n").forEach((l, i) => { const m = l.match(/\s\^([\w-]+)\s*$/) || l.match(/^\^([\w-]+)\s*$/); if (m) cand.push({ id: m[1], line: it.line + i }); });
        for (const [id, b] of Object.entries(c.blocks || {})) if (b.position.start.line >= it.line && b.position.start.line <= end + 1) cand.push({ id, line: b.position.start.line });
        const rank = (x) => (x.line === it.line ? 0 : x.line === end + 1 ? 1 : 2);
        cand.sort((a, b) => rank(a) - rank(b) || a.line - b.line);
        for (const x of cand) { const e = fc[x.id] || fc[x.id.toLowerCase()]; if (e?.nid) return Number(e.nid); }
        return null;
    }
    // 今天到期的卡所属的笔记（两分钟内复用）；手机上按快照，去掉快照之后已经在哪台设备上答过的
    async ankiDueNotes() {
        if (MOBILE) {
            const snap = this.snap, out = new Set();
            if (snap) for (const [nid, cids] of Object.entries(snap.notes)) if (cids.some((c) => snap.due.has(c)) && !this.answeredSince(cids)) out.add(Number(nid));
            return out;
        }
        if (this.dueCache && Date.now() - this.dueCache.at < 2 * 60 * 1000) return this.dueCache.notes;
        const ids = await this.anki("findCards", { query: "is:due -is:suspended -is:buried" });
        const info = ids.length ? await this.anki("cardsInfo", { cards: ids }) : [];
        this.dueCache = { at: Date.now(), notes: new Set(info.map((x) => x.note)) };
        return this.dueCache.notes;
    }
    // 卡片状态的说法；复习卡的「还有几天」用 Anki 搜索 prop:due<=k 二分出来（AnkiConnect 不直接给日期）
    async ankiState(card) {
        if (card.queue === -1) return t("suspended");
        if (card.queue < -1) return t("buried");
        if (card.queue === 0) return t("isNew");
        if (card._due) return card.queue === 2 ? t("dueToday") : t("learning");
        if (card.queue !== 2) return t("learning");
        let lo = 1, hi = Math.max(2, card.interval * 2 + 30), left = null;
        try {
            if ((await this.anki("findCards", { query: `cid:${card.cardId} prop:due<=${hi}` })).length) {
                while (lo < hi) { const mid = (lo + hi) >> 1; if ((await this.anki("findCards", { query: `cid:${card.cardId} prop:due<=${mid}` })).length) hi = mid; else lo = mid + 1; }
                left = lo;
            }
        } catch (e) { /* 算不出来就不写天数 */ }
        return left != null ? t("inDays", { n: left }) : t("interval", { n: card.interval });
    }
    async openAt(file, line, evt) {
        const ws = this.app.workspace;
        const mod = evt && Keymap.isModEvent(evt);
        // 这篇已经在主区开着：切过去定位，不再开一个新标签
        let leaf = mod === "split" || mod === "window" ? null : ws.getLeavesOfType("markdown").find((l) => {
            const root = l.getRoot();
            return root !== ws.leftSplit && root !== ws.rightSplit && (l.view?.file?.path || l.getViewState().state?.file) === file.path;
        });
        if (leaf) {
            await leaf.loadIfDeferred?.();
            ws.setActiveLeaf(leaf, { focus: true });
            await ws.revealLeaf(leaf);
            leaf.view.setEphemeralState?.({ line });
        } else {
            leaf = ws.getLeaf(mod || "tab");
            await leaf.openFile(file, { eState: { line } });
        }
        await sleep(60);
        await revealLine(leaf.view, line);
    }
};

// ---------- 设置 ----------
class CWSettings extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const c = this.containerEl; c.empty();
        const p = this.plugin, s = p.settings;
        const save = () => p.saveSettings();
        const text = (name, desc, key) => new Setting(c).setName(name).setDesc(desc || "").addText((x) => x.setValue(String(s[key] ?? "")).onChange(async (v) => { s[key] = v; await save(); }));
        const num = (name, desc, key, min = 1, float = false) => new Setting(c).setName(name).setDesc(desc || "").addText((x) => x.setValue(String(s[key])).onChange(async (v) => { const n = float ? parseFloat(v) : parseInt(v); if (n >= min) { s[key] = n; await save(); } }));
        const tog = (name, desc, key) => new Setting(c).setName(name).setDesc(desc || "").addToggle((x) => x.setValue(!!s[key]).onChange(async (v) => { s[key] = v; await save(); }));
        const area = (name, desc, key, rows) => { let ta; new Setting(c).setName(name).setDesc(desc).addTextArea((x) => { ta = x; x.setValue(String(s[key] ?? "")).onChange(async (v) => { s[key] = v; await save(); }); x.inputEl.rows = rows; x.inputEl.addClass("cw-wide"); }); return ta; };

        new Setting(c).setName(t("sSync")).setDesc(t("sSyncD")).setHeading();
        text(t("sRelayUrl"), t("sRelayUrlD"), "relayUrl");
        new Setting(c).setName(t("sRelayTok")).setDesc(t("sRelayTokD")).addText((x) => {
            x.inputEl.type = "password";
            x.setValue(String(s.relayToken || "")).onChange(async (v) => { s.relayToken = v; await save(); });
        });
        new Setting(c).setName(t("sDevName")).setDesc(t("sDevNameD")).addText((x) => x.setValue(p.local.name).onChange((v) => { p.local.name = v.trim() || p.local.name; p.saveLocal(); }));
        const test = new Setting(c).setName(t("sTest"));
        test.addButton((b) => b.setButtonText(t("sTest")).onClick(async () => {
            const t0 = Date.now();
            try { await p.relay.run([["PING"]]); test.setDesc(t("sTestOk", { ms: Date.now() - t0 })); p.syncState = { connecting: true }; p.poll(); }
            catch (e) { test.setDesc(t("sTestFail", { e: e.message || e })); }
        }));

        new Setting(c).setName(t("sCards")).setHeading();
        text(t("sJournal"), t("sJournalD"), "journalFolder");
        text(t("sExclude"), t("sExcludeD"), "excludeFolders");
        text(t("sPrivate"), t("sPrivateD"), "privateLinks");
        num(t("sCount"), "", "reviewCount");
        num(t("sGoal"), "", "reviewGoal");
        tog(t("sAutoOpen"), t("sAutoOpenD"), "autoOpen");
        const subjArea = area(t("sSubjects"), t("sSubjectsD"), "subjects", 6);
        new Setting(c).setName(t("sSuggest")).setDesc(t("sSuggestD")).addButton((b) => b.setButtonText(t("sSuggestB")).onClick(async () => {
            b.setDisabled(true);
            try {
                const lines = await p.suggestSubjects();
                if (!lines.length) { new Notice(t("suggestNone")); return; }
                s.subjects = [String(s.subjects || "").trim(), ...lines].filter(Boolean).join("\n");
                subjArea.setValue(s.subjects);
                await save();
                new Notice(t("suggestAdded", { n: lines.length }));
            } finally { b.setDisabled(false); }
        }));

        new Setting(c).setName(t("sWeight")).setHeading();
        num(t("sRecent"), t("sRecentD"), "recentBoost", 1, true);
        area(t("sBoost"), t("sBoostD"), "boostLinks", 3);
        num(t("sBoostN"), t("sBoostND"), "linkBoost", 1, true);

        new Setting(c).setName(t("sLang")).setHeading();
        text(t("sLangP"), t("sLangPD"), "langPattern");
        text(t("sLangE"), t("sLangED"), "langExcept");
        tog(t("sLangG"), t("sLangGD"), "langGuess");
        text(t("sKnow"), t("sKnowD"), "knowledgeFolders");

        new Setting(c).setName(t("sAnki")).setHeading();
        tog(t("sAnkiR"), t("sAnkiRD"), "ankiReview");
        text(t("sAnkiUrl"), "", "ankiUrl");
        tog(t("sDurChk"), t("sDurChkD"), "durationCheck");
        tog(t("sAutoSync"), t("sAutoSyncD"), "ankiAutoSync");
        tog(t("sLog"), t("sLogD"), "reviewLog");
        text(t("sLogTpl"), t("sLogTplD", { tpl: t("logTpl") }), "reviewLogTemplate");

        new Setting(c).setName(t("sFx")).setHeading();
        tog(t("sSound"), t("sSoundD"), "fxSound");
        tog(t("sAnim"), t("sAnimD"), "fxAnim");
        new Setting(c).setName(t("sVol")).setDesc(t("sVolD"))
            .addSlider((sl) => sl.setLimits(0, 100, 5).setValue(Number(s.fxVolume) || 0).setDynamicTooltip().onChange(async (v) => { s.fxVolume = v; await save(); }))
            .addButton((b) => b.setButtonText(t("sTry")).onClick(() => { FX.reveal(fxVol(s)); setTimeout(() => FX.up(fxVol(s)), 600); setTimeout(() => FX.down(fxVol(s)), 1500); setTimeout(() => FX.erase(fxVol(s)), 2400); }));
    }
}
