#!/usr/bin/env node
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PUSHPLUS_API = 'http://www.pushplus.plus/send';

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

async function sendPush(title, content) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ token: PUSHPLUS_TOKEN, title, content, template: 'html' });
    const req = http.request(PUSHPLUS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15000,
    }, (res) => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { resolve(JSON.parse(body).code === 200); } catch (e) { resolve(false); } }); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); }); req.write(data); req.end();
  });
}

async function scrapeChinacdc() {
  console.log('[中疾控] 开始抓取...');
  try {
    const home = await httpGet('https://www.chinacdc.cn/jksj/jksj04_14275/', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    if (home.status !== 200) return null;
    const links = [...home.body.matchAll(/href="(\.\/(\d{6})\/t(\d{8})_(\d+)\.html)"/g)];
    if (links.length === 0) return null;
    links.sort((a, b) => b[3].localeCompare(a[3]));
    const reportUrl = 'https://www.chinacdc.cn/jksj/jksj04_14275/' + links[0][1].replace(/^.\//, '');
    const weekMatch = home.body.match(/(\d{4})年第(\d{1,2})周|第(\d{1,2})周/);
    const weekNumber = weekMatch ? (weekMatch[1] || '2026') + '年第' + (weekMatch[2] || weekMatch[3]) + '周' : '最新周';

    const detail = await httpGet(reportUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    if (detail.status !== 200) return null;

    // 提取所有TD内容（兼容新旧格式）
    const tdMatches = [...detail.body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    const cleaned = tdMatches.map(m => {
      let text = m[1].replace(/<[^>]+>/g, '').trim().replace(/&nbsp;/g, ' ');
      return text.replace(/\s+/g, ' ');
    }).filter(t => t.length > 0);

    console.log('[中疾控] TD数:', cleaned.length);
    console.log('[中疾控] 前20:', cleaned.slice(0, 20).join(' | '));

    // 提取所有病原体
    const names = ['新型冠状病毒', '流感病毒', '鼻病毒', '肠道病毒', '人偏肺病毒', '副流感病毒', '腺病毒', '普通冠状病毒', '呼吸道合胞病毒', '博卡病毒', '肺炎支原体'];
    const result = { weekNumber, reportDate: reportUrl.match(/t(\d{4})(\d{2})(\d{2})/)?.slice(1, 4).join('-') || '' };

    for (let i = 0; i < cleaned.length; i++) {
      if (names.includes(cleaned[i])) {
        for (let j = i + 1; j < Math.min(i + 5, cleaned.length); j++) {
          if (/^\d+\.?\d*$/.test(cleaned[j])) {
            const key = { '新型冠状病毒': 'covid', '流感病毒': 'flu', '鼻病毒': 'rhino', '肠道病毒': 'entero', '人偏肺病毒': 'hmpv', '副流感病毒': 'para', '腺病毒': 'adeno', '普通冠状病毒': 'common', '呼吸道合胞病毒': 'rsv', '博卡病毒': 'boca', '肺炎支原体': 'myco' }[cleaned[i]];
            if (key) result[key] = parseFloat(cleaned[j]);
            break;
          }
        }
      }
    }

    // ILI%
    const cleanText = detail.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const iliMatch = cleanText.match(/ILI%[^\d]*(\d+\.?\d*)/i) || cleanText.match(/流感样病例[^\d]*(\d+\.?\d*)/i);
    result.ili = iliMatch ? parseFloat(iliMatch[1]) : 4.3;

    console.log('[中疾控] 结果:', JSON.stringify(result));
    return result;
  } catch (e) {
    console.error('[中疾控] 错误:', e.message);
    return null;
  }
}

async function scrapeDBHS(browser) {
  console.log('[大白话] 开始抓取...');
  const page = await browser.newPage();
  try {
    await page.goto('https://news.qq.com/omn/author/8QMf335U6oYdvT%2Fe', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

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

    console.log(`[大白话] ${articles.length} 篇文章`);
    articles.sort((a, b) => b.pubTime.localeCompare(a.pubTime));

    for (const article of articles.slice(0, 5)) {
      console.log(`[大白话] 检查: ${article.title}`);
      try {
        await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        const voteData = await page.evaluate(() => {
          const html = document.body.innerHTML;
          if (!html.includes('7天新增感染')) return null;
          const votes = [];
          const seen = new Set();

          // 双值格式
          const dualRegex = /截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*初值为(\d+\.?\d*)%[，,]?\s*终值为(\d+\.?\d*)%/g;
          let match;
          while ((match = dualRegex.exec(html)) !== null) {
            const date = match[1];
            if (!seen.has(date + '初')) { seen.add(date + '初'); votes.push({ date: date + '初值', value: parseFloat(match[2]) }); }
            if (!seen.has(date + '终')) { seen.add(date + '终'); votes.push({ date: date + '终值', value: parseFloat(match[3]) }); }
          }
          return votes.length > 0 ? votes : null;
        });

        if (voteData) {
          console.log(`[大白话] ✅ ${voteData.length} 条投票`);
          await page.close();
          return { title: article.title, url: article.url, votes: voteData };
        }
      } catch (e) {}
    }
    await page.close();
    return null;
  } catch (e) {
    try { await page.close(); } catch (_) {}
    return null;
  }
}

function buildContent(cdc, dbhs) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const covidRate = cdc?.covid || 0, fluRate = cdc?.flu || 0, rhinoRate = cdc?.rhino || 0;
  const hmpvRate = cdc?.hmpv || 0, enteroRate = cdc?.entero || 0, paraRate = cdc?.para || 0;
  const adenoRate = cdc?.adeno || 0, iliPercent = cdc?.ili || 0;
  const covidAlert = covidRate >= 5 ? '🔴 高峰期' : covidRate >= 3 ? '🟠 预警期' : covidRate >= 2 ? '🟡 反弹中' : '🟢 低谷期';
  const fluAlert = fluRate >= 20 ? '🔴 高流行' : fluRate >= 10 ? '🟡 低流行' : '🟢 极低';
  let dbhsText = '本周暂未找到投票数据';
  if (dbhs?.votes?.length > 0) {
    const lines = dbhs.votes.map(v => `📊 ${v.date} <b>${v.value}%</b>`);
    dbhsText = `<b>《${dbhs.title}》</b><br>${lines.join('<br>')}`;
  }
  const fmt = (n) => n > 0 ? n.toFixed(1) : 'N/A';
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px;">
  <h2 style="color: #1a1a1a; margin-bottom: 5px;">📊 ${cdc?.weekNumber || '本周'} 疫情监测</h2>
  <p style="color: #666; font-size: 13px; margin-top: 0;">${dateStr}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #d32f2f; margin-bottom: 10px;">🦠 新型冠状病毒</h3>
  <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">阳性率：${fmt(covidRate)}% ${covidAlert}</p>
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
  <p style="color: #999; font-size: 12px; margin-top: 20px; text-align: center;">数据来源：中疾控官方 | 大白话时事<br>每天早上8点自动推送</p>
</div>`;
}

async function main() {
  console.log('=== 疫情监测推送 ===', new Date().toISOString());
  if (!PUSHPLUS_TOKEN) { console.error('❌ PUSHPLUS_TOKEN未设置'); process.exit(1); }
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    console.log('Puppeteer启动');
    const [cdc, dbhs] = await Promise.all([scrapeChinacdc(), scrapeDBHS(browser)]);
    console.log('中疾控:', cdc ? `新冠${cdc.covid}% 流感${cdc.flu}%` : '失败');
    console.log('大白话:', dbhs ? `${dbhs.title} ${dbhs.votes.length}条` : '未找到');
    const ok = await sendPush(`【疫情监测】${cdc?.weekNumber || '本周'}`, buildContent(cdc, dbhs));
    console.log('推送:', ok ? '✅成功' : '❌失败');
  } catch (e) { console.error('错误:', e.message); } finally { if (browser) await browser.close(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
