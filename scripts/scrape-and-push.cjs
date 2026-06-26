#!/usr/bin/env node
/**
 * 全自动疫情监测推送脚本 - GitHub Actions 版本
 */

const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PUSHPLUS_API = 'http://www.pushplus.plus/send';

function log(...args) {
  console.log(...args);
}

// ====== 用Node.js原生https请求（支持gzip解压）======
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { ...headers, 'Accept-Encoding': 'gzip, deflate' }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) resolve({ status: res.statusCode, body: buffer.toString() });
            else resolve({ status: res.statusCode, body: decoded.toString() });
          });
        } else {
          resolve({ status: res.statusCode, body: buffer.toString() });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ====== 推送函数 ======
async function sendPush(title, content) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      token: PUSHPLUS_TOKEN,
      title,
      content,
      template: 'html',
    });
    const req = http.request(PUSHPLUS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body).code === 200); } catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ====== 抓取中疾控 ======
async function scrapeChinacdc() {
  log('📊 [中疾控] 开始抓取...');
  try {
    // 1. 获取首页
    const home = await httpGet('https://www.chinacdc.cn/jksj/jksj04_14275/', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    if (home.status !== 200) { log('❌ [中疾控] 首页失败:', home.status); return null; }

    // 2. 找最新报告链接
    const links = [...home.body.matchAll(/href="(\.\/(\d{6})\/t(\d{8})_(\d+)\.html)"/g)];
    if (links.length === 0) { log('❌ [中疾控] 未找到链接'); return null; }
    links.sort((a, b) => b[3].localeCompare(a[3]));
    const latest = links[0];
    const reportUrl = 'https://www.chinacdc.cn/jksj/jksj04_14275/' + latest[1].replace(/^\.\//, '');

    const weekMatch = home.body.match(/(\d{4})年第(\d{1,2})周|第(\d{1,2})周/);
    const weekNumber = weekMatch ? (weekMatch[1] || '2026') + '年第' + (weekMatch[2] || weekMatch[3]) + '周' : '最新周';

    log('📄 [中疾控] 报告:', reportUrl, weekNumber);

    // 3. 抓取详情页
    const detail = await httpGet(reportUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    if (detail.status !== 200) { log('❌ [中疾控] 详情页失败:', detail.status); return null; }

    // 4. 提取所有TD内容
    const tdMatches = [...detail.body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    const cleaned = tdMatches.map(m => {
      let text = m[1].replace(/<[^>]+>/g, '').trim();
      text = text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      return text;
    }).filter(t => t.length > 0);

    log('📋 [中疾控] 找到', cleaned.length, '个TD单元格');
    log('📋 [中疾控] 前20个:', cleaned.slice(0, 20).join(' | '));

    // 5. 找病原体
    const names = ['新型冠状病毒', '流感病毒', '鼻病毒', '肠道病毒', '人偏肺病毒', '副流感病毒', '腺病毒', '普通冠状病毒', '呼吸道合胞病毒', '博卡病毒', '肺炎支原体'];
    const pathogens = {};

    for (let i = 0; i < cleaned.length; i++) {
      if (names.includes(cleaned[i])) {
        for (let j = i + 1; j < Math.min(i + 5, cleaned.length); j++) {
          if (/^\d+\.?\d*$/.test(cleaned[j])) {
            pathogens[cleaned[i]] = parseFloat(cleaned[j]);
            break;
          }
        }
      }
    }

    log('🔬 [中疾控] 病原体:', Object.keys(pathogens).map(k => k + ':' + pathogens[k] + '%').join(', '));

    // 6. 提取ILI%
    let ili = 4.3;
    const cleanText = detail.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const iliMatch = cleanText.match(/ILI%[^\d]*(\d+\.?\d*)/i) || cleanText.match(/流感样病例[^\d]*(\d+\.?\d*)/i);
    if (iliMatch) ili = parseFloat(iliMatch[1]);

    const dateMatch = reportUrl.match(/t(\d{4})(\d{2})(\d{2})/);
    const reportDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';

    return {
      weekNumber, reportDate, ili,
      covid: pathogens['新型冠状病毒'] || 0,
      flu: pathogens['流感病毒'] || 0,
      rhino: pathogens['鼻病毒'] || 0,
      entero: pathogens['肠道病毒'] || 0,
      hmpv: pathogens['人偏肺病毒'] || 0,
      para: pathogens['副流感病毒'] || 0,
      adeno: pathogens['腺病毒'] || 0,
    };
  } catch (e) {
    log('❌ [中疾控] 错误:', e.message);
    return null;
  }
}

// ====== 抓取大白话 ======
async function scrapeDBHS(browser) {
  log('📱 [大白话] 开始抓取...');
  const page = await browser.newPage();

  try {
    // 1. 打开作者页
    log('🌐 [大白话] 打开作者页...');
    await page.goto('https://news.qq.com/omn/author/8QMf335U6oYdvT%2Fe', {
      waitUntil: 'networkidle2', timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 5000));

    // 2. 从React fiber提取文章列表
    const articles = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('.author-article-item').forEach(el => {
        const fiberKey = Object.keys(el).find(k => k.includes('__reactFiber'));
        if (!fiberKey) return;
        let node = el[fiberKey];
        for (let i = 0; i < 10 && node; i++, node = node.return) {
          const data = node?.memoizedProps?.value?.articleData;
          if (data?.id) {
            results.push({ id: data.id, title: data.title, pubTime: data.pubTime, url: 'https://news.qq.com/rain/a/' + data.id });
            break;
          }
        }
      });
      return results;
    });

    log(`📋 [大白话] 找到 ${articles.length} 篇文章`);
    articles.forEach((a, i) => log(`   [${i}] ${a.pubTime} | ${a.title}`));

    if (articles.length === 0) { await page.close(); return null; }

    // 3. 按时间排序，找最新文章
    articles.sort((a, b) => b.pubTime.localeCompare(a.pubTime));

    for (const article of articles.slice(0, 10)) { // 检查前10篇，避免非投票文章过多时遗漏
      log(`🔎 [大白话] 检查: ${article.title}`);
      try {
        await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        // 4. 提取投票数据
        const voteData = await page.evaluate(() => {
          const html = document.body.innerHTML;
          if (!html.includes('7天新增感染')) return null;

          const votes = [];
          const seen = new Set();

          // 方法1: 提取包含完整投票数据的段落
          const paras = document.querySelectorAll('p, div, span');
          for (const el of paras) {
            const text = el.textContent || '';
            // 匹配 "截止X月X日，7天新增感染比例，初值为X.XX%，终值为X.XX%"
            const match = text.match(/截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*初值为(\d+\.?\d*)%[，,]?\s*终值为(\d+\.?\d*)%/);
            if (match) {
              const date = match[1];
              const key1 = date + '初值:' + match[2];
              const key2 = date + '终值:' + match[3];
              if (!seen.has(key1)) { seen.add(key1); votes.push({ date: date + '初值', value: parseFloat(match[2]) }); }
              if (!seen.has(key2)) { seen.add(key2); votes.push({ date: date + '终值', value: parseFloat(match[3]) }); }
            }
          }

          // 方法2: 如果方法1没找到，从整个HTML正则提取
          if (votes.length === 0) {
            const regex = /截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*初值为(\d+\.?\d*)%[，,]?\s*终值为(\d+\.?\d*)%/g;
            let m;
            while ((m = regex.exec(html)) !== null) {
              const date = m[1];
              const key1 = date + '初值:' + m[2];
              const key2 = date + '终值:' + m[3];
              if (!seen.has(key1)) { seen.add(key1); votes.push({ date: date + '初值', value: parseFloat(m[2]) }); }
              if (!seen.has(key2)) { seen.add(key2); votes.push({ date: date + '终值', value: parseFloat(m[3]) }); }
            }
          }

          return votes.length > 0 ? votes : null;
        });

        if (voteData && voteData.length > 0) {
          log(`  ✅ [大白话] 找到 ${voteData.length} 条投票:`);
          voteData.forEach(v => log(`     ${v.date}: ${v.value}%`));
          await page.close();
          return { title: article.title, url: article.url, votes: voteData };
        }
      } catch (e) {
        log(`  ⚠️ [大白话] 错误: ${e.message}`);
      }
    }

    await page.close();
    return null;
  } catch (e) {
    log('❌ [大白话] Puppeteer错误:', e.message);
    try { await page.close(); } catch (_) {}
    return null;
  }
}

// ====== 构建推送 ======
function buildContent(cdc, dbhs) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;

  const covidRate = cdc?.covid || 0;
  const fluRate = cdc?.flu || 0;
  const rhinoRate = cdc?.rhino || 0;
  const hmpvRate = cdc?.hmpv || 0;
  const enteroRate = cdc?.entero || 0;
  const paraRate = cdc?.para || 0;
  const adenoRate = cdc?.adeno || 0;
  const iliPercent = cdc?.ili || 0;

  const covidAlert = covidRate >= 5 ? '🔴 高峰期' : covidRate >= 3 ? '🟠 预警期' : covidRate >= 2 ? '🟡 反弹中' : '🟢 低谷期';
  const fluAlert = fluRate >= 20 ? '🔴 高流行' : fluRate >= 10 ? '🟡 低流行' : '🟢 极低';

  let dbhsText = '本周暂未找到投票数据';
  if (dbhs?.votes?.length > 0) {
    const lines = dbhs.votes.map(v => `📊 ${v.date} <b>${v.value}%</b>`);
    dbhsText = `<b>《${dbhs.title}》</b><br>${lines.join('<br>')}`;
  }

  const fmt = (n) => n > 0 ? n.toFixed(1) : 'N/A';
  const weekNum = cdc?.weekNumber || '本周';

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px;">
  <h2 style="color: #1a1a1a; margin-bottom: 5px;">📊 ${weekNum} 疫情监测</h2>
  <p style="color: #666; font-size: 13px; margin-top: 0;">${dateStr}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #d32f2f; margin-bottom: 10px;">🦠 新型冠状病毒</h3>
  <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">阳性率：${fmt(covidRate)}% ${covidAlert}</p>
  <p style="color: #666; font-size: 13px;">中疾控实验室检测 | ${cdc?.reportDate || ''}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #f57c00; margin-bottom: 10px;">🤧 流感病毒</h3>
  <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">阳性率：${fmt(fluRate)}% ${fluAlert}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #1976d2; margin-bottom: 10px;">📋 其他病原体</h3>
  <table style="width: 100%; font-size: 14px;">
    <tr><td>鼻病毒</td><td style="text-align: right;"><b>${fmt(rhinoRate)}%</b></td></tr>
    <tr><td>肠道病毒</td><td style="text-align: right;"><b>${fmt(enteroRate)}%</b></td></tr>
    <tr><td>副流感病毒</td><td style="text-align: right;"><b>${fmt(paraRate)}%</b></td></tr>
    <tr><td>人偏肺病毒</td><td style="text-align: right;"><b>${fmt(hmpvRate)}%</b></td></tr>
    <tr><td>腺病毒</td><td style="text-align: right;"><b>${fmt(adenoRate)}%</b></td></tr>
    <tr><td>ILI%</td><td style="text-align: right;"><b>${fmt(iliPercent)}%</b></td></tr>
  </table>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #388e3c; margin-bottom: 10px;">📰 大白话时事·读者投票</h3>
  <p style="font-size: 14px; margin: 5px 0; line-height: 1.8;">${dbhsText}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #d32f2f; margin-bottom: 10px;">⚠️ 预警与建议</h3>
  <div style="background: #fff3e0; padding: 12px; border-radius: 8px; font-size: 14px;">
    ${covidRate >= 5 ? '<p>🔴 <b>新冠高峰期：</b>务必佩戴口罩，减少聚集。</p>' : covidRate >= 3 ? '<p>🟠 <b>新冠预警期：</b>建议佩戴口罩。</p>' : '<p>🟢 <b>新冠：</b>低谷期，保持基本防护。</p>'}
    ${fluRate >= 10 ? '<p>🟡 <b>流感：</b>低流行，建议接种疫苗。</p>' : ''}
  </div>
  <p style="color: #999; font-size: 12px; margin-top: 20px; text-align: center;">数据来源：中疾控官方 | 大白话时事<br>每天早上8点自动推送 · GitHub Actions版</p>
</div>`;
}

// ====== 主程序 ======
async function main() {
  log('========================================');
  log('🚀 疫情监测推送开始');
  log('⏰', new Date().toISOString());
  log('========================================');

  if (!PUSHPLUS_TOKEN) {
    log('❌ PUSHPLUS_TOKEN 未设置');
    process.exit(1);
  }

  let browser;
  try {
    log('🖥️  启动 Puppeteer...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    log('✅ Puppeteer 启动成功');

    // 并行抓取
    log('\n--- 开始抓取数据 ---');
    const [cdc, dbhs] = await Promise.all([
      scrapeChinacdc(),
      scrapeDBHS(browser),
    ]);

    // 构建推送
    log('\n--- 构建推送 ---');
    const weekNum = cdc?.weekNumber || '本周';
    const alertEmoji = (cdc?.covid || 0) >= 5 ? '🔴' : '';
    const title = `【疫情监测】${weekNum} ${alertEmoji} [GitHub Actions]`;
    const content = buildContent(cdc, dbhs);

    // 发送
    log('\n--- 发送推送 ---');
    const ok = await sendPush(title, content);
    log(ok ? '✅ 推送成功' : '❌ 推送失败');

  } catch (e) {
    log('💥 致命错误:', e.message);
    await sendPush('【疫情监测】推送异常 [GitHub Actions]', `<p>错误：${e.message}</p>`);
  } finally {
    if (browser) await browser.close();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
