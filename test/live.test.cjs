// pi-grok-search 真实 API 集成测试（可选）
// 需要已配置 GROK_API_URL / GROK_API_KEY（环境变量或 ~/.config/grok-search/env）
// 未配置时自动跳过（退出码 0），不会阻塞 CI / 新环境首次安装
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, {});

const { config } = jiti(path.join(__dirname, '..', 'lib', 'config.ts'));
const { GrokProvider } = jiti(path.join(__dirname, '..', 'lib', 'grok.ts'));
const { splitAnswerAndSources } = jiti(path.join(__dirname, '..', 'lib', 'sources.ts'));

async function main() {
  console.log('== 配置 ==');
  console.log(JSON.stringify(config.getConfigInfo(), null, 2));

  let apiUrl, apiKey;
  try {
    apiUrl = config.grokApiUrl;
    apiKey = config.grokApiKey;
  } catch (e) {
    console.log(`\n⏭️  未配置 GROK_API_URL / GROK_API_KEY（${e.message}），跳过 live 测试。`);
    console.log('   配置方法见 README.md 或 .env.example。');
    process.exit(0);
  }

  console.log(`\n== 搜索: ${config.grokModel} @ ${apiUrl} ==`);
  const provider = new GrokProvider(apiUrl, apiKey, config.grokModel, config.grokApiMode);
  const t0 = Date.now();
  const result = await provider.search('今天全球 AI 领域有什么大事？', '', undefined, undefined);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，返回 ${result.length} 字符\n`);

  const [answer, sources] = splitAnswerAndSources(result);
  console.log('== 答案（前 800 字符）==');
  console.log(answer.slice(0, 800));
  console.log(`\n== 信源 ${sources.length} 条 ==`);
  for (const s of sources.slice(0, 10)) {
    console.log(`- ${s.title ?? '(无标题)'} ${s.url}`);
  }

  const ok = result.length > 50;
  console.log(ok ? '\n🎉 live 测试通过' : '\n💥 live 测试失败（返回过短）');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('💥 live 测试异常:', e);
  process.exit(1);
});
