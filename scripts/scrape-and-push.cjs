#!/usr/bin/env node
/**
 * 疫情监测全自动推送脚本
 * 使用 Puppeteer 抓取大白话最新文章 + 中疾控数据
 * 调用 PushPlus 推送微信
 */

const puppeteer = require('puppeteer');
const http = require('http');

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '35eefe300b4348a98ba76995c2371849';
const PUSHPLUS_API = 'http://www.pushplus.plus/send';

// ====== 推送函数 ======
async function sendPush(title, content) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ token: PUSHPLUS_TOKEN, title, content, template: 'html' });
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

// ====== 抓取中疾控数据 ======
async function scrapeChinacdc() {
  console.log('Fetching 中CDC data...');
  try {
    const resp = await fetch('https://www.chinacdc.cn/jksj/jksj04_14275/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const html = await resp.text();
    const links = [...html.matchAll(/href="(\.\/(\d{6})\/t(\d{8})_(\d+)\.html)"/g)];
    if (links.length === 0) return null;
    links.sort((a, b) => b[3].localeCompare(a[3]));
    const latest = links[0];
    const reportUrl = 'https://www.chinacdc.cn/jksj/jksj04_14275/' + latest[1].replace(/^\.\//, '');

    const detailResp = await fetch(reportUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const detailHtml = await detailResp.text();

    const extract = (name) => {
      const p = new RegExp(`<td[^>]*>\\s*<p[^>]*>${name}</p></td>\\s*<td[^>]*>[\\s\\S]*?<p[^>]*>(?:<[^>]+>)*([\\d.]+)(?:<[^>]+>)*</p>`, 'i');
      const m = detailHtml.match(p);
      return m ? parseFloat(m[1]) : null;
    };

    const covid = extract('新型冠状病毒');
    const flu = extract('流感病毒');
    const rhino = extract('鼻病毒');
    const hmpv = extract('人偏肺病毒');
    const iliMatch = detailHtml.match(/ILI%[^\d]*([\d.]+)/i);
    const weekMatch = html.match(/第(\d{1,2})周|(\d{4})年第(\d{1,2})周/);
    const weekNumber = weekMatch ? '2026年第' + (weekMatch[3] || weekMatch[1]) + '周' : '最新周';

    return { weekNumber, covidRate: covid || 0, fluRate: flu || 0, rhinoRate: rhino || 0, hmpvRate: hmpv || 0, iliPercent: iliMatch ? parseFloat(iliMatch[1]) : 0, hasData: !!covid };
  } catch (e) {
    console.error('中CDC error:', e.message);
    return null;
  }
}

// ====== 使用 Puppeteer 抓取大白话 ======
async function scrapeDBHS(browser) {
  console.log('Fetching 大白话 articles with Puppeteer...');
  const page = await browser.newPage();

  try {
    // 打开作者页
    await page.goto('https://news.qq.com/omn/author/8QMf335U6oYdvT%2Fe', {
      waitUntil: 'networkidle2', timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 3000));

    // 从React fiber中提取文章列表
    const articles = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('.author-article-item').forEach(el => {
        const fiberKey = Object.keys(el).find(k => k.includes('__reactFiber'));
        if (!fiberKey) return;
        let node = el[fiberKey];
        for (let i = 0; i < 10 && node; i++, node = node.return) {
          const data = node?.memoizedProps?.value?.articleData;
          if (data?.id) {
            results.push({
              id: data.id,
              title: data.title,
              pubTime: data.pubTime,
              url: 'https://news.qq.com/rain/a/' + data.id,
            });
            break;
          }
        }
      });
      return results;
    });

    console.log(`Found ${articles.length} articles`);
    articles.forEach((a, i) => console.log(`  [${i}] ${a.pubTime} | ${a.title}`));

    // 按时间排序，找最新且包含投票数据的文章
    articles.sort((a, b) => b.pubTime.localeCompare(a.pubTime));

    for (const article of articles) {
      console.log(`Checking: ${article.title}`);
      try {
        await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));

        const voteData = await page.evaluate(() => {
          const html = document.body.innerHTML;
          if (!html.includes('7天新增感染')) return null;
          const votes = [];
          const seen = new Set();
          
          // 正则1: 提取 "初值为X.XX%，终值为X.XX%" 格式（一行有两个值）
          const dualRegex = /截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*初值为(\d+\.?\d*)%[，,]?\s*终值为(\d+\.?\d*)%/g;
          let match;
          while ((match = dualRegex.exec(html)) !== null) {
            const date = match[1];
            const initial = parseFloat(match[2]);
            const final = parseFloat(match[3]);
            const key1 = date + ':初值' + initial;
            const key2 = date + ':终值' + final;
            if (!seen.has(key1)) { seen.add(key1); votes.push({ date: date + '初值', value: initial }); }
            if (!seen.has(key2)) { seen.add(key2); votes.push({ date: date + '终值', value: final }); }
          }
          
          // 正则2: 提取单独的 "初值为X.XX%" 或 "终值为X.XX%"
          const singleRegex = /截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*(初值|终值)为(\d+\.?\d*)%/g;
          while ((match = singleRegex.exec(html)) !== null) {
            const date = match[1] + match[2];
            const val = parseFloat(match[3]);
            const key = date + ':' + val;
            if (!seen.has(key)) { seen.add(key); votes.push({ date, value: val }); }
          }
          
          // 兜底: 简单格式
          if (votes.length === 0) {
            const simpleRegex = /截止(\d{1,2}月\d{1,2}日)[，,]?\s*7天新增感染比例[，,]?\s*(\d+\.?\d*)%/g;
            while ((match = simpleRegex.exec(html)) !== null) {
              votes.push({ date: match[1], value: parseFloat(match[2]) });
            }
          }
          return votes.length > 0 ? votes : null;
        });

        if (voteData) {
          console.log(`  ✅ Found ${voteData.length} vote entries`);
          await page.close();
          return { title: article.title, url: article.url, votes: voteData };
        }
      } catch (e) {
        console.log(`  Error: ${e.message}`);
      }
    }

    await page.close();
    return null;
  } catch (e) {
    console.error('Puppeteer error:', e.message);
    try { await page.close(); } catch (_) {}
    return null;
  }
}

// ====== 构建推送内容 ======
function buildContent(cdcData, dbhsData) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  const covidRate = cdcData?.covidRate || 0;
  const fluRate = cdcData?.fluRate || 0;
  const rhinoRate = cdcData?.rhinoRate || 0;
  const hmpvRate = cdcData?.hmpvRate || 0;
  const iliPercent = cdcData?.iliPercent || 0;

  let covidAlert = covidRate >= 5 ? '🔴 高峰期' : covidRate >= 3 ? '🟠 预警期' : covidRate >= 2 ? '🟡 反弹中' : '🟢 低谷期';
  let fluAlert = fluRate >= 20 ? '🔴 高流行' : fluRate >= 10 ? '🟡 低流行' : '🟢 极低';

  let dbhsText = '本周暂未找到投票数据';
  if (dbhsData?.votes?.length > 0) {
    const seen = new Set();
    const lines = dbhsData.votes
      .filter(v => { const k = `${v.date}:${v.value}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(v => {
        // 如果date包含"初值"或"终值"，显示为 "6月14日终值 4.25%"
        const date = v.date.replace('初值', '初值').replace('终值', '终值');
        return `📊 ${date} <b>${v.value}%</b>`;
      });
    dbhsText = `<b>《${dbhsData.title}》</b><br>${lines.join('<br>')}`;
  }

  const fmt = (n) => typeof n === 'number' && n > 0 ? n.toFixed(1) : 'N/A';
  const weekNum = cdcData?.weekNumber || '本周';

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px;">
  <h2 style="color: #1a1a1a; margin-bottom: 5px;">📊 ${weekNum} 疫情监测</h2>
  <p style="color: #666; font-size: 13px; margin-top: 0;">${dateStr}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #d32f2f; margin-bottom: 10px;">🦠 新型冠状病毒</h3>
  <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">阳性率：${fmt(covidRate)}% ${covidAlert}</p>
  <p style="color: #666; font-size: 13px;">中疾控实验室检测</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #f57c00; margin-bottom: 10px;">🤧 流感病毒</h3>
  <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">阳性率：${fmt(fluRate)}% ${fluAlert}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
  <h3 style="color: #1976d2; margin-bottom: 10px;">📋 其他病原体</h3>
  <table style="width: 100%; font-size: 14px;">
    <tr><td>鼻病毒</td><td style="text-align: right;"><b>${fmt(rhinoRate)}%</b></td></tr>
    <tr><td>人偏肺病毒</td><td style="text-align: right;"><b>${fmt(hmpvRate)}%</b></td></tr>
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

// ====== 主程序 ======
async function main() {
  console.log('=== 疫情监测推送 ===');
  console.log('Time:', new Date().toISOString());

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    console.log('Puppeteer launched');

    const [cdcData, dbhsData] = await Promise.all([
      scrapeChinacdc(),
      scrapeDBHS(browser),
    ]);

    console.log('\n=== 抓取结果 ===');
    console.log('中疾控:', cdcData ? `新冠${cdcData.covidRate}% 流感${cdcData.fluRate}%` : '失败');
    console.log('大白话:', dbhsData ? `${dbhsData.title} (${dbhsData.votes.length}条投票)` : '未找到');

    const weekNum = cdcData?.weekNumber || '本周';
    const title = `【疫情监测】${weekNum} ${cdcData?.covidRate >= 5 ? '🔴新冠高峰期' : ''}`;
    const content = buildContent(cdcData, dbhsData);

    console.log('\nSending push...');
    const ok = await sendPush(title, content);
    console.log('Push:', ok ? '✅ 成功' : '❌ 失败');

  } catch (e) {
    console.error('Main error:', e.message);
    await sendPush('【疫情监测】推送异常', `<p>错误：${e.message}</p>`);
  } finally {
    if (browser) await browser.close();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('Fatal:', e); process.exit(1); });
