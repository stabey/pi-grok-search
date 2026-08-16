// pi-grok-search 信源提取逻辑测试（纯本地，无需网络/API Key/pi 环境）
// 依赖 jiti（devDependencies）加载 TypeScript 源码
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, {});
const { splitAnswerAndSources, mergeSources, extractUniqueUrls } = jiti(
  path.join(__dirname, '..', 'lib', 'sources.ts'),
);

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

// 1. citation_card 函数调用
const [ans1, src1] = splitAnswerAndSources(
  `Grok 是 xAI 的模型。\n\ncitation_card(\n  [\n    {"url": "https://x.ai/grok", "title": "Grok"}, \n    {"url": "https://example.com/2", "title": "Example"}\n  ]\n)`,
);
check('citation_card 提取', src1.length === 2 && src1[0].url === 'https://x.ai/grok', JSON.stringify(src1));
check('citation_card 答案剥离', ans1.includes('Grok 是 xAI') && !ans1.includes('citation_card'));

// 2. Sources 标题块
const [ans2, src2] = splitAnswerAndSources(
  `答案是 A。\n\n## Sources\n1. [链接1](https://a.com/1)\n2. [链接2](https://b.com/2)`,
);
check('heading 提取', src2.length === 2 && src2[0].url === 'https://a.com/1', JSON.stringify(src2));
check('heading 答案剥离', ans2.trim() === '答案是 A。');

// 3. details 块
const [ans3, src3] = splitAnswerAndSources(
  `答案 B。\n\n<details>\n<summary>Sources</summary>\n- [S1](https://c.com/1)\n- [S2](https://d.com/2)\n</details>`,
);
check('details 提取', src3.length === 2, JSON.stringify(src3));
check('details 答案剥离', ans3.trim() === '答案 B。');

// 4. 文尾链接块
const [ans4, src4] = splitAnswerAndSources(`答案 C。\n\n- https://e.com/1\n- https://f.com/2`);
check('tail 提取', src4.length === 2, JSON.stringify(src4));
check('tail 答案剥离', ans4.trim() === '答案 C。');

// 5. 行内引用
const [ans5, src5] = splitAnswerAndSources(`答案 D [1](https://g.com/1)。`);
check('inline 提取', src5.length === 1 && src5[0].provider === 'grok-inline', JSON.stringify(src5));

// 5b. 双括号行内引用（Grok 实际输出格式）
const [ans5b, src5b] = splitAnswerAndSources(`答案 D1[[1]](https://g.com/1)[[2]](https://g.com/2)。`);
check('双括号 inline 提取', src5b.length === 2 && src5b[0].url === 'https://g.com/1', JSON.stringify(src5b));

// 5c. 双括号 + 重复 URL 去重
const [, src5c] = splitAnswerAndSources(`[[1]](https://g.com/1)[[2]](https://g.com/1)`);
check('双括号去重', src5c.length === 1, JSON.stringify(src5c));

// 6. 无信源时原样返回
const [ans6, src6] = splitAnswerAndSources('普通回答，没有链接。');
check('无信源', src6.length === 0 && ans6 === '普通回答，没有链接。');

// 7. 裸 URL 提取
const urls = extractUniqueUrls('见 https://a.com/1 和 https://a.com/1 重复，以及 https://b.com/x?q=1。');
check('URL 去重', urls.length === 2 && urls[0] === 'https://a.com/1', JSON.stringify(urls));

// 8. merge 去重
const merged = mergeSources(
  [{ url: 'https://a.com', title: 'A' }],
  [{ url: 'https://a.com', title: 'A 重复' }, { url: 'https://b.com' }],
);
check('merge 去重', merged.length === 2 && merged[0].title === 'A');

// 9. 中文标题块
const [ans9, src9] = splitAnswerAndSources(
  `答案 E。\n\n## 参考资料\n- [中文站](https://zh.com/1)\n- [中文站2](https://zh.com/2)`,
);
check('中文标题块', src9.length === 2 && src9[0].title === '中文站', JSON.stringify(src9));

// 10. 字符串形式 citation_card
const [ans10, src10] = splitAnswerAndSources(
  `答案 F。\nsources(\n  '["https://h.com/1", "https://i.com/2"]'\n)`,
);
check('字符串 payload', src10.length === 2, JSON.stringify(src10));

console.log(failed === 0 ? '\n🎉 全部通过' : `\n💥 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
