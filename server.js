const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('.'));

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

if (!TAVILY_API_KEY) console.warn('⚠️  TAVILY_API_KEY not set');
if (!GROQ_API_KEY)   console.warn('⚠️  GROQ_API_KEY not set');

// ─────────────────────────────────────────────────────────────────────────────
// Tavily: search web for current prices & availability in India
// ─────────────────────────────────────────────────────────────────────────────
async function tavilySearch(query, maxResults = 3) {
  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        query,
        search_depth: 'advanced',
        include_answer: true,
        include_raw_content: false,
        max_results: maxResults
        // No include_domains filter — cast wide net for more results
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TAVILY_API_KEY}`
        },
        timeout: 30000
      }
    );
    return response.data;
  } catch (err) {
    console.warn('Tavily search failed:', err.message);
    return { answer: '', results: [] };
  }
}

async function tavilyMultiSearch(queries) {
  const results = await Promise.allSettled(queries.map(q => tavilySearch(q, 3)));
  const combined = { answer: '', results: [] };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.answer) combined.answer += r.value.answer + '\n';
      combined.results.push(...(r.value.results || []));
    }
  }
  // Deduplicate by URL
  const seen = new Set();
  combined.results = combined.results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  return combined;
}

function formatSearchContext(tavilyData) {
  let ctx = '';
  if (tavilyData.answer) ctx += `WEB SUMMARY: ${tavilyData.answer.slice(0, 500)}\n\n`;
  ctx += tavilyData.results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content.slice(0, 300)}\n`)
    .join('\n---\n');
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq: recommend PCs using both its knowledge AND Tavily price context
// ─────────────────────────────────────────────────────────────────────────────
async function groqRecommend(prompt, maxTokens = 6000) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured in .env');
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are SPECTR, an expert PC hardware advisor specializing in the Indian market. 
You have deep knowledge of all laptop and desktop models from Dell, HP, Lenovo, ASUS, Acer, MSI, Apple, Samsung, LG, Microsoft and others.
You know their exact specifications — CPU models, RAM, storage, GPU, display, battery, ports, weight.
You always give COMPLETE, DETAILED specifications. You NEVER write "Not specified" — if you know a spec (and you do), you write it.
You always recommend REAL models that actually exist and are sold in India.`
        },
        
        { role: 'user', content: prompt }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );
  return response.data.choices[0].message.content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Known brand lists for validation
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_PC_BRANDS = [
  'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi', 'apple', 'razer',
  'google', 'microsoft', 'samsung', 'lg', 'gigabyte', 'zebronics',
  'iball', 'rdp', 'avita', 'infinix', 'honor', 'huawei', 'xiaomi',
  'realme', 'vaio', 'toshiba', 'fujitsu', 'panasonic', 'chuwi'
];

const KNOWN_PRINTER_BRANDS = [
  'hp', 'canon', 'epson', 'brother', 'ricoh', 'xerox', 'samsung',
  'pantum', 'kyocera', 'konica minolta', 'sharp', 'lexmark', 'dell',
  'toshiba', 'panasonic', 'oki', 'fujifilm', 'fuji xerox'
];

function checkBrandExists(preferredBrand, knownBrands) {
  if (!preferredBrand || !preferredBrand.trim()) return { provided: false, exists: true };
  const normalized = preferredBrand.trim().toLowerCase();
  const exists = knownBrands.some(b => normalized.includes(b) || b.includes(normalized));
  return { provided: true, exists, brand: preferredBrand.trim() };
}

function parseJSON(raw) {
  const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in response');
  return JSON.parse(clean.slice(start, end + 1));
}

// ============ MAIN ENDPOINT ===================================================
app.post('/api/get-recommendations', async (req, res) => {
  try {
    const specs = req.body;
    if (!GROQ_API_KEY) return res.status(400).json({ error: 'GROQ_API_KEY not configured in .env' });

    // Validate preferred brand exists
    const brandCheck = checkBrandExists(specs.preferred_brand, KNOWN_PC_BRANDS);
    if (brandCheck.provided && !brandCheck.exists) {
      return res.status(400).json({
        success: false,
        error: `Brand "${brandCheck.brand}" does not exist or is not available in the Indian PC/laptop market. Please choose a valid brand (e.g. Dell, HP, Lenovo, ASUS, Acer, MSI, Apple, Samsung, LG, Microsoft) or leave it blank for no preference.`
      });
    }

    const deviceType = specs.device_type === 'desktop' ? 'Desktop PC' : 'Laptop';
    const budget = Number(specs.budget).toLocaleString('en-IN');
    const year = new Date().getFullYear();
    const useCase = specs.use_case || 'general';
    const procGen = specs.processor_gen || '';
    const ram = specs.ram || '';

    // If the user picked a specific brand, the results should ONLY contain that brand
    const hasPreferredBrand = !!(specs.preferred_brand && specs.preferred_brand.trim());
    const preferredBrand = hasPreferredBrand ? specs.preferred_brand.trim() : '';

    console.log(`\n🔍 Finding: ${deviceType} under Rs.${budget} | ${useCase}${hasPreferredBrand ? ` | Brand-locked: ${preferredBrand}` : ''}`);

    // Tavily: get current Indian market prices and top models
    let searchContext = '';
    if (TAVILY_API_KEY) {
      const queries = hasPreferredBrand ? [
        `best ${preferredBrand} ${deviceType} under Rs ${specs.budget} India ${year}`,
        `${preferredBrand} ${deviceType} ${procGen} ${ram} price India ${year}`,
        `${preferredBrand} ${deviceType} ${useCase} India ${year} specifications price`
      ].filter(q => q.trim().length > 10) : [
        `best ${deviceType} under Rs ${specs.budget} India ${year} buy`,
        `${procGen} ${ram} RAM ${deviceType} price India ${year} Flipkart`,
        `top ${deviceType} ${useCase} India ${year} review specifications price`
      ].filter(q => q.trim().length > 10);

      const searchData = await tavilyMultiSearch(queries);
      searchContext = formatSearchContext(searchData);
      console.log(`📦 Tavily: ${searchData.results.length} results`);
    }

    // Build the prompt — Groq uses BOTH its knowledge AND Tavily price context
    const taskInstructions = hasPreferredBrand ? `YOUR TASK:
Recommend 4-6 REAL ${deviceType} models, ALL of them from the brand "${preferredBrand}" — and ONLY from "${preferredBrand}".
- Do NOT include any other brand under any circumstances, even if you think another brand is a better match.
- Cover different series/price points within "${preferredBrand}" (e.g. entry-level, mid-range, premium) so the customer has a few options to compare.
- Use the web search data above for current prices; use your knowledge for complete specifications
- Every single field MUST be filled — no "Not specified" allowed
- Calculate match_score (0-100) based on how well each model meets ALL the customer's requirements
- If a model is slightly over budget, include it but lower its match_score and note it
- The "brands" array in your JSON response must contain EXACTLY ONE brand object, for "${preferredBrand}", with all the recommended models inside it.` : `YOUR TASK:
Recommend 8-10 REAL ${deviceType} models available in India right now.
- Pick models from AT LEAST 5 different brands (max 2 per brand)
- Use the web search data above for current prices; use your knowledge for complete specifications
- Every single field MUST be filled — no "Not specified" allowed
- Calculate match_score (0-100) based on how well each model meets ALL the customer's requirements
- If a model is slightly over budget, include it but lower its match_score and note it`;

    const closingInstruction = hasPreferredBrand
      ? `Now generate recommendations for the customer's actual requirements above. Remember: EVERY model must be a real "${preferredBrand}" ${deviceType} — do not include any other brand. All fields mandatory.`
      : `Now generate recommendations for the customer's actual requirements above. Include brands like Dell, HP, Lenovo, ASUS, Acer, MSI, and others. All fields mandatory.`;

    const prompt = `A customer in India wants to buy a ${deviceType} in ${year}. Find the best options for them.

CUSTOMER REQUIREMENTS:
- Budget: Rs.${budget} (strict maximum — do not exceed)
- Device Type: ${deviceType}
- Primary Use: ${useCase}
- Processor Brand: ${specs.processor_brand || 'Any (Intel or AMD)'}
- Processor Generation: ${procGen || 'Latest generation (13th/14th Gen Intel or Ryzen 7000 series)'}
- Minimum CPU Cores: ${specs.min_cores || 'Any'}
- RAM Required: ${ram || '8GB minimum'}${specs.ram_type ? ' ' + specs.ram_type : ''}
- Storage Required: ${specs.storage || '512GB SSD'}
- GPU Type: ${specs.gpu_type || 'Any'}${specs.gpu_model ? ' specifically ' + specs.gpu_model : ''}
- Wireless: ${specs.connectivity || 'Wi-Fi 6 or better'}
- OS: ${specs.os || 'Windows 11'}
- Preferred Brand: ${hasPreferredBrand ? `${preferredBrand} — STRICT REQUIREMENT: show ONLY ${preferredBrand} models, no other brand` : 'No preference — show multiple brands'}
- Additional Notes: ${specs.notes || 'None'}

${searchContext ? `CURRENT INDIAN MARKET DATA (from live web search — use these prices):
${searchContext}

` : ''}${taskInstructions}

REQUIRED JSON (respond with ONLY valid JSON, no text before or after, no markdown):
{
  "brands": [
    {
      "brand": "BrandName",
      "models": [
        {
          "id": "brand-model-id",
          "brand": "BrandName",
          "name": "Full Model Name",
          "price_inr": "Rs. XX,XXX",
          "price_usd": "$XXX",
          "cpu": "Full CPU name with cores and GHz",
          "ram": "XGB DDR4/DDR5",
          "storage": "XXXGB NVMe SSD",
          "gpu": "GPU name",
          "os": "Windows 11 Home/Pro",
          "networking": "Wi-Fi X, Bluetooth X.X",
          "warranty": "X Year",
          "certifications": "Energy Star etc",
          "match_score": 90,
          "match_note": "Why this matches or doesn't"
        }
      ]
    }
  ]
}

${closingInstruction}`;

    const raw = await groqRecommend(prompt, 7000);
    const result = parseJSON(raw);

    res.json({
      success: true,
      source: TAVILY_API_KEY ? 'tavily-prices + groq-specs' : 'groq-knowledge',
      ...result
    });

  } catch (error) {
    console.error('Recommendations Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message || 'Server error' });
  }
});

// ============ CHAT ENDPOINT ===================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const lastMessage = messages[messages.length - 1]?.content || '';

    let searchContext = '';
    if (TAVILY_API_KEY) {
      const searchData = await tavilySearch(`${lastMessage} India ${new Date().getFullYear()}`, 5);
      searchContext = formatSearchContext(searchData);
    }

    const prompt = `You are SPECTR's expert AI PC advisor for India.
Answer this question with specific, accurate details about specs and current Indian prices.
${searchContext ? `\nRecent web data:\n${searchContext}\n` : ''}
Question: ${lastMessage}`;

    const reply = await groqRecommend(prompt, 1500);
    res.json({ reply });

  } catch (error) {
    console.error('Chat Error:', error.message);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// ============ LEGACY RECOMMEND ================================================
app.post('/api/recommend', async (req, res) => {
  try {
    const specs = req.body;
    const budgetINR = Number(specs.budget).toLocaleString('en-IN');
    const year = new Date().getFullYear();

    let searchContext = '';
    if (TAVILY_API_KEY) {
      const searchData = await tavilyMultiSearch([
        `best PC laptop under Rs ${specs.budget} India ${year}`,
        `government procurement laptop desktop India ${year}`
      ]);
      searchContext = formatSearchContext(searchData);
    }

    const prompt = `Government IT procurement in India ${year}.
Budget: Rs.${budgetINR} per unit. Quantity: ${specs.quantity || 1}. Notes: ${specs.notes || 'Standard office use'}.
${searchContext ? `Web data: ${searchContext}\n` : ''}
Find the single best match and 2 alternatives. Respond ONLY with raw JSON:
{
  "summary": "brief summary",
  "search_time": "${new Date().toLocaleDateString('en-IN')}",
  "best": {
    "brand": "Dell", "model": "Vostro 3520", "price_inr": "Rs. 45,990", "price_usd": "$550",
    "processor": "Intel Core i5-1235U", "ram": "8GB DDR4", "storage": "512GB SSD",
    "match_score": 95, "reasoning": "Best value for government use",
    "pros": ["Good build quality", "1 year onsite warranty", "Energy Star certified"],
    "cons": ["Integrated graphics only", "Basic display"]
  },
  "alternatives": [
    {"rank": 2, "brand": "HP", "model": "255 G9", "price_inr": "Rs. 43,500", "match_score": 88, "note": "Slightly cheaper, AMD processor"},
    {"rank": 3, "brand": "Lenovo", "model": "IdeaPad Slim 3", "price_inr": "Rs. 42,990", "match_score": 85, "note": "Good keyboard, reliable brand"}
  ]
}`;

    const raw = await groqRecommend(prompt, 2500);
    const result = parseJSON(raw);
    res.json({ success: true, ...result });

  } catch (error) {
    console.error('Recommend Error:', error.message);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// ============ PRINTER RECOMMENDATIONS ========================================
app.post('/api/get-printer-recommendations', async (req, res) => {
  try {
    const specs = req.body;
    if (!GROQ_API_KEY) return res.status(400).json({ error: 'GROQ_API_KEY not configured in .env' });

    // Validate preferred brand exists
    const brandCheck = checkBrandExists(specs.preferred_brand, KNOWN_PRINTER_BRANDS);
    if (brandCheck.provided && !brandCheck.exists) {
      return res.status(400).json({
        success: false,
        error: `Brand "${brandCheck.brand}" does not exist or is not available in the Indian printer market. Please choose a valid brand (e.g. HP, Canon, Epson, Brother, Ricoh, Xerox, Samsung, Pantum, Kyocera) or leave it blank for no preference.`
      });
    }

    const budget = Number(specs.budget).toLocaleString('en-IN');
    const year = new Date().getFullYear();
    const useCase = specs.use_case || 'office';

    // If the user picked a specific brand, the results should ONLY contain that brand
    const hasPreferredBrand = !!(specs.preferred_brand && specs.preferred_brand.trim());
    const preferredBrand = hasPreferredBrand ? specs.preferred_brand.trim() : '';

    console.log(`\n🖨️  Finding Printer under Rs.${budget} | ${useCase}${hasPreferredBrand ? ` | Brand-locked: ${preferredBrand}` : ''}`);

    // Tavily: get current Indian market prices for printers
    let searchContext = '';
    if (TAVILY_API_KEY) {
      const queries = hasPreferredBrand ? [
        `best ${preferredBrand} printer under Rs ${specs.budget} India ${year}`,
        `${preferredBrand} ${specs.technology || 'laser'} printer ${specs.functions || 'MFP'} India ${year} price`,
        `${preferredBrand} printer ${useCase} India ${year} specifications price`
      ].filter(q => q.trim().length > 10) : [
        `best printer under Rs ${specs.budget} India ${year} buy`,
        `${specs.technology || 'laser'} printer ${specs.functions || 'MFP'} India ${year} price`,
        `top office printer India ${year} review specifications price`
      ].filter(q => q.trim().length > 10);

      const searchData = await tavilyMultiSearch(queries);
      searchContext = formatSearchContext(searchData);
      console.log(`📦 Tavily: ${searchData.results.length} results`);
    }

    const printerTaskInstructions = hasPreferredBrand ? `YOUR TASK:
Recommend 4-6 REAL Printer models, ALL of them from the brand "${preferredBrand}" — and ONLY from "${preferredBrand}".
- Do NOT include any other brand under any circumstances, even if you think another brand is a better match.
- Cover different series/price points within "${preferredBrand}" (e.g. entry-level, mid-range, premium) so the customer has a few options to compare.
- Use web search data for current prices; use your knowledge for complete specifications
- Every single field MUST be filled — no "Not specified" allowed
- Calculate match_score (0-100) based on how well each model meets ALL requirements
- If a model is slightly over budget, include it but note it in match_score
- The "brands" array in your JSON response must contain EXACTLY ONE brand object, for "${preferredBrand}", with all the recommended models inside it.` : `YOUR TASK:
Recommend 6-8 REAL Printer models available in India right now.
- Pick models from AT LEAST 4 different brands (max 2 per brand)
- Include brands like HP, Canon, Epson, Brother, Ricoh, Xerox, Samsung, Pantum
- Use web search data for current prices; use your knowledge for complete specifications
- Every single field MUST be filled — no "Not specified" allowed
- Calculate match_score (0-100) based on how well each model meets ALL requirements
- If a model is slightly over budget, include it but note it in match_score`;

    const printerClosingInstruction = hasPreferredBrand
      ? `Now generate recommendations for the customer's actual requirements. Remember: EVERY model must be a real "${preferredBrand}" printer — do not include any other brand. All fields mandatory.`
      : `Now generate recommendations for the customer's actual requirements. Include brands like HP, Canon, Epson, Brother, Ricoh, Xerox, Pantum. All fields mandatory.`;

    const prompt = `A customer in India wants to buy a Printer in ${year}. Find the best options for them.

CUSTOMER REQUIREMENTS:
- Budget: Rs.${budget} (strict maximum — do not exceed)
- Primary Use: ${useCase}
- Print Technology: ${specs.technology || 'Laser'}
- Functions: ${specs.functions || 'Print + Copy + Scan (MFP)'}
- Color Type: ${specs.color_type || 'Monochrome'}
- Minimum Print Speed: ${specs.print_speed || '30'} PPM
- Monthly Duty Cycle: ${specs.duty_cycle || '30000'}+ pages
- Copy Speed: ${specs.copy_speed || 'Not specified'} CPM
- Scan Speed: ${specs.scan_speed || 'Not specified'} PPM
- Print Resolution: ${specs.resolution || '1200x1200 dpi'}
- Duplex: ${specs.duplex || 'Automatic'}
- Paper Sizes: ${specs.paper_size || 'A4, Legal, Letter'}
- Memory: ${specs.memory || '512MB'}+
- Processor Speed: ${specs.processor_speed || '1200MHz'}+
- Connectivity: ${specs.connectivity || 'USB + Ethernet + Wi-Fi'}
- Network Speed: ${specs.network_speed || '10/100 Mbps'}
- Scan File Formats: ${specs.scan_formats || 'PDF, JPG, TIFF'}
- Preferred Brand: ${hasPreferredBrand ? `${preferredBrand} — STRICT REQUIREMENT: show ONLY ${preferredBrand} models, no other brand` : 'No preference — show multiple brands'}
- Warranty: ${specs.warranty || '1 Year'}
- Additional Notes: ${specs.notes || 'None'}

${searchContext ? `CURRENT INDIAN MARKET DATA (from live web search — use these prices):
${searchContext}

` : ''}${printerTaskInstructions}

REQUIRED JSON (respond with ONLY valid JSON, no text before or after, no markdown):
{
  "brands": [
    {
      "brand": "HP",
      "models": [
        {
          "id": "brand-model-id",
          "brand": "HP",
          "name": "Full Model Name",
          "price_inr": "Rs. XX,XXX",
          "price_usd": "$XXX",
          "technology": "Laser/Inkjet (Print, Copy, Scan)",
          "print_speed": "XX PPM",
          "copy_speed": "XX CPM",
          "scan_speed": "XX PPM",
          "resolution": "XXXX x XXXX dpi",
          "duplex": "Automatic/Manual",
          "memory": "XXX MB",
          "processor_speed": "XXXX MHz",
          "paper_size": "A4, Letter, Legal",
          "duty_cycle": "XX,XXX pages/month",
          "connectivity": "USB, Ethernet, Wi-Fi",
          "scan_formats": "PDF, JPEG, TIFF",
          "os_support": "Windows, macOS",               
          "warranty": "1 Year",
          "certifications": "Energy Star",
          "match_score": 90,
          "match_note": "Why this matches"
        }-
      ]
    }
  ]
}

${printerClosingInstruction}`;

    const raw = await groqRecommend(prompt, 6000);
    const result = parseJSON(raw);

    res.json({
      success: true,
      source: TAVILY_API_KEY ? 'tavily-prices + groq-specs' : 'groq-knowledge',
      device_type: 'printer',
      ...result
    });

  } catch (error) {
    console.error('Printer Recommendations Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message || 'Server error' });
  }
});


app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    search: TAVILY_API_KEY ? 'Tavily ✓ (live prices)' : 'Not configured (using Groq knowledge only)',
    llm: GROQ_API_KEY ? 'Groq Llama-3.3-70b ✓' : 'NOT CONFIGURED',
    note: 'Groq provides complete specs; Tavily enriches with current Indian prices',
    timestamp: new Date()
  });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   SPECTR AI PC Advisor                            ║
║   Running on http://localhost:${PORT}             ║
║                                                   ║
║   🔍 Tavily: live Indian market prices            ║
║   🧠 Groq:   complete PC specifications           ║
║   ✅ Full details — no more "Not specified"       ║
╚═══════════════════════════════════════════════════╝`);
  console.log(`📱 Open: http://localhost:${PORT}`);
  console.log(`🔍 Tavily:  ${TAVILY_API_KEY ? '✓ (prices from web)' : '⚠️  not set — prices from Groq knowledge'}`);
  console.log(`🧠 Groq:    ${GROQ_API_KEY   ? '✓' : '❌ missing GROQ_API_KEY'}`);
});
