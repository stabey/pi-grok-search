// web_fetch / web_map 注册条件（纯本地，无需网络/API Key/pi 环境）
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, {});
const { isConfiguredApiKey, resolveFetchTools, planSearchToolNames, webFetchBackends } = jiti(
  path.join(__dirname, '..', 'lib', 'config.ts'),
);

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

check('key: undefined 视为未配置', isConfiguredApiKey(undefined) === false);
check('key: 空字符串视为未配置', isConfiguredApiKey('') === false);
check('key: 仅空白视为未配置', isConfiguredApiKey('   \t') === false);
check('key: 非空视为已配置', isConfiguredApiKey('tvly-xxx') === true);

const none = resolveFetchTools({ tavilyEnabled: true });
check('无 key → 不注册 fetch/map', none.webFetch === false && none.webMap === false);
check('无 key → 规划工具仅 web_search', planSearchToolNames(none).join(',') === 'web_search');

const blank = resolveFetchTools({
  tavilyApiKey: '  ',
  firecrawlApiKey: '\n',
  tavilyEnabled: true,
});
check('空白 key → 不注册 fetch/map', blank.webFetch === false && blank.webMap === false);

const firecrawlOnly = resolveFetchTools({
  firecrawlApiKey: 'fc-xxx',
  tavilyEnabled: true,
});
check('仅 Firecrawl → 只注册 web_fetch', firecrawlOnly.webFetch === true && firecrawlOnly.webMap === false);
check(
  '仅 Firecrawl → 规划枚举含 fetch 不含 map',
  planSearchToolNames(firecrawlOnly).join(',') === 'web_search,web_fetch',
);

const tavily = resolveFetchTools({
  tavilyApiKey: 'tvly-xxx',
  tavilyEnabled: true,
});
check('Tavily 启用 → 注册 fetch+map', tavily.webFetch === true && tavily.webMap === true);
check(
  'Tavily 启用 → 规划枚举含 fetch+map',
  planSearchToolNames(tavily).join(',') === 'web_search,web_fetch,web_map',
);

const tavilyOff = resolveFetchTools({
  tavilyApiKey: 'tvly-xxx',
  tavilyEnabled: false,
});
check('Tavily 关闭且无 Firecrawl → 都不注册', tavilyOff.webFetch === false && tavilyOff.webMap === false);

const tavilyOffFirecrawl = resolveFetchTools({
  tavilyApiKey: 'tvly-xxx',
  firecrawlApiKey: 'fc-xxx',
  tavilyEnabled: false,
});
check(
  'Tavily 关闭 + Firecrawl → 只注册 web_fetch',
  tavilyOffFirecrawl.webFetch === true && tavilyOffFirecrawl.webMap === false,
);
check(
  'Tavily 关闭 + Firecrawl → Tavily 后端不可用',
  tavilyOffFirecrawl.tavily === false && tavilyOffFirecrawl.firecrawl === true,
);
check(
  'Tavily 关闭 + Firecrawl → web_fetch 只走 Firecrawl',
  webFetchBackends(tavilyOffFirecrawl).join(',') === 'firecrawl',
);
check(
  'Tavily 启用 + Firecrawl → web_fetch 先 Tavily 再 Firecrawl',
  webFetchBackends({ tavily: true, firecrawl: true }).join(',') === 'tavily,firecrawl',
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
