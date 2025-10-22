require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.on('error', (error) => {
  console.error('client error:', error.message);
});

const volumeCache = {
  '5m': { topVolume: [], sellingPressure: [] },
  '15m': { topVolume: [], sellingPressure: [] },
  '1h': { topVolume: [], sellingPressure: [] },
  '4h': { topVolume: [], sellingPressure: [] },
  '1d': { topVolume: [], sellingPressure: [] }
};

let excludedBaseCoins = new Set();
let volumeHistory1d = [];
let lastUpdateTime = null;

const BYBIT_BASE = 'https://api.bybit.com';

function getBaseCoin(symbol) {
  let base = symbol.replace('USDT', '').replace('PERP', '');
  if (base.startsWith('1000')) {
    base = base.substring(4);
  }
  return base;
}

async function fetchVolumeData(timeframe, targetTimestamp = null) {
  const response = await axios.get(`${BYBIT_BASE}/v5/market/tickers`, {
    params: { category: 'linear' }
  });
  
  const volumeData = [];
  
  if (response.data?.result?.list) {
    const perpetualSymbols = response.data.result.list
      .filter(t => {
        if (!t.symbol || !t.lastPrice) return false;
        if (!t.symbol.endsWith('USDT')) return false;
        if (/-\d{2}[A-Z]{3}\d{2}/.test(t.symbol)) return false;
        return true;
      })
      .map(t => t.symbol);
    
    const batchSize = 50;
    for (let i = 0; i < perpetualSymbols.length; i += batchSize) {
      const batch = perpetualSymbols.slice(i, i + batchSize);
      
      const promises = batch.map(async symbol => {
        try {
          const ticker = response.data.result.list.find(t => t.symbol === symbol);
          const lastPrice = parseFloat(ticker.lastPrice);
          const priceChange = parseFloat(ticker.price24hPcnt || 0) * 100;
          const volume24h = parseFloat(ticker.turnover24h || 0);
          
          const intervalMap = {
            '5m': { interval: '1', limit: 5 },
            '15m': { interval: '5', limit: 3 },
            '1h': { interval: '15', limit: 4 },
            '4h': { interval: '60', limit: 4 },
            '1d': { interval: 'D', limit: 1 }
          };
          
          const config = intervalMap[timeframe];
          const klineParams = {
            category: 'linear',
            symbol: symbol,
            interval: config.interval,
            limit: config.limit
          };
          
          if (targetTimestamp) {
            klineParams.end = targetTimestamp;
          }
          
          const klineResponse = await axios.get(`${BYBIT_BASE}/v5/market/kline`, {
            params: klineParams
          });
          
          if (klineResponse.data?.result?.list && klineResponse.data.result.list.length >= config.limit) {
            const volumeTimeframe = klineResponse.data.result.list.reduce((sum, candle) => {
              return sum + parseFloat(candle[6]);
            }, 0);
            
            return {
              symbol,
              lastPrice,
              volumeTimeframe,
              volume24h,
              priceChange
            };
          }
        } catch (err) {
          return null;
        }
        return null;
      });
      
      const results = await Promise.all(promises);
      volumeData.push(...results.filter(r => r !== null && r.volumeTimeframe > 0));
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  return volumeData;
}

function shouldExcludeCoin(symbol) {
  const baseCoin = getBaseCoin(symbol);
  return excludedBaseCoins.has(baseCoin);
}

async function backfillHistory() {
  console.log('\n' + '='.repeat(50));
  console.log('backfilling 7 days of 1d volume history...');
  console.log('='.repeat(50));
  
  for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - daysAgo);
    targetDate.setHours(12, 0, 0, 0);
    const timestamp = targetDate.getTime();
    
    console.log(`fetching 1d volume for ${targetDate.toDateString()}...`);
    
    try {
      const volumeData = await fetchVolumeData('1d', timestamp);
      volumeData.sort((a, b) => b.volumeTimeframe - a.volumeTimeframe);
      
      const top15Symbols = volumeData.slice(0, 15).map(v => v.symbol);
      volumeHistory1d.push({
        timestamp: timestamp,
        coins: top15Symbols
      });
      
      console.log(`  ✓ ${top15Symbols.length} coins tracked`);
    } catch (error) {
      console.log(`  ✗ failed - ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  const baseCoinCounts = {};
  volumeHistory1d.forEach(record => {
    record.coins.forEach(symbol => {
      const baseCoin = getBaseCoin(symbol);
      baseCoinCounts[baseCoin] = (baseCoinCounts[baseCoin] || 0) + 1;
    });
  });
  
  Object.entries(baseCoinCounts).forEach(([baseCoin, count]) => {
    if (count >= 5) {
      excludedBaseCoins.add(baseCoin);
    }
  });
  
  console.log(`\n✓ backfill complete! ${excludedBaseCoins.size} coins will be excluded`);
  console.log('='.repeat(50) + '\n');
}

async function updateVolumeCache() {
  console.log('\n' + '='.repeat(50));
  console.log(`updating volume data at ${new Date().toLocaleTimeString()}`);
  console.log('='.repeat(50));
  
  try {
    const timeframes = ['5m', '15m', '1h', '4h', '1d'];
    
    for (const tf of timeframes) {
      console.log(`fetching ${tf} volume data...`);
      const volumeData = await fetchVolumeData(tf);
      volumeData.sort((a, b) => b.volumeTimeframe - a.volumeTimeframe);
      
      if (tf === '1d') {
        const top15Symbols = volumeData.slice(0, 15).map(v => v.symbol);
        volumeHistory1d.push({
          timestamp: Date.now(),
          coins: top15Symbols
        });
        
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        volumeHistory1d = volumeHistory1d.filter(record => record.timestamp >= sevenDaysAgo);
        
        const baseCoinCounts = {};
        volumeHistory1d.forEach(record => {
          record.coins.forEach(symbol => {
            const baseCoin = getBaseCoin(symbol);
            baseCoinCounts[baseCoin] = (baseCoinCounts[baseCoin] || 0) + 1;
          });
        });
        
        excludedBaseCoins.clear();
        Object.entries(baseCoinCounts).forEach(([baseCoin, count]) => {
          if (count >= 5) {
            excludedBaseCoins.add(baseCoin);
          }
        });
      }
      
      const filteredData = volumeData.filter(coin => !shouldExcludeCoin(coin.symbol));
      

      volumeCache[tf].topVolume = filteredData.slice(0, 10);
      
      // ok new update, selling pressure: filter negative price change, sort by volume (highest first)
      const sellingPressureData = filteredData
        .filter(coin => coin.priceChange < 0)
        .sort((a, b) => b.volumeTimeframe - a.volumeTimeframe)
        .slice(0, 10);
      
      volumeCache[tf].sellingPressure = sellingPressureData;
      
      const excluded = volumeData.length - filteredData.length;
      console.log(`✓ ${tf} updated - ${volumeData.length} contracts (${excluded} regulars excluded)`);
    }
    
    lastUpdateTime = new Date();
    console.log(`✓ update complete at ${lastUpdateTime.toLocaleTimeString()}`);
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    console.error('update failed:', error.message);
  }
}

function formatVolume(volume) {
  if (volume >= 1000000000) {
    return `$${(volume / 1000000000).toFixed(2)}B`;
  } else if (volume >= 1000000) {
    return `$${(volume / 1000000).toFixed(2)}M`;
  } else if (volume >= 1000) {
    return `$${(volume / 1000).toFixed(2)}K`;
  }
  return `$${volume.toFixed(2)}`;
}

function formatPrice(price) {
  if (price >= 1000) return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`.replace(/\.?0+$/, '');
}

function createVolumeEmbed(timeframe, data, isHighVolume) {
  const title = isHighVolume 
    ? `Top 10 Volume (${timeframe})`
    : `Top 10 Selling Pressure (${timeframe})`;
  
  const lines = data.map((item) => {
    let symbolDisplay = item.symbol.replace('USDT', '');
    if (symbolDisplay.endsWith('PERP')) {
      symbolDisplay = symbolDisplay.slice(0, -4);
    }
    
    if (!symbolDisplay || symbolDisplay.length < 2) {
      symbolDisplay = item.symbol;
    }
    
    symbolDisplay = symbolDisplay.padEnd(12);
    
    const priceStr = formatPrice(item.lastPrice).padEnd(10);
    const volumeStr = formatVolume(item.volumeTimeframe).padEnd(12);
    
    const changeSign = item.priceChange >= 0 ? '+' : '';
    const changeStr = `(${changeSign}${item.priceChange.toFixed(1)}%)`;
    
    return `${symbolDisplay} ${priceStr} 📊 ${volumeStr} ${changeStr}`;
  }).join('\n');
  
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription('```\n' + lines + '\n```')
    .setColor(isHighVolume ? 0x00ff00 : 0xff0000);
  
  if (lastUpdateTime) {
    const timeStr = lastUpdateTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    embed.setFooter({ text: `Powered by Bybit • Updates every 5min • Last update: ${timeStr}` });
  }
  
  return embed;
}

client.once('ready', async () => {
  console.log(`\n✓ logged in as ${client.user.tag}`);
  console.log(`✓ bot id: ${client.user.id}`);
  console.log(`✓ connected to ${client.guilds.cache.size} server(s)\n`);
  
  const commands = [
    {
      name: 'volume',
      description: 'Show top volume and selling pressure for different timeframes'
    }
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log('✓ commands synced\n');
  } catch (error) {
    console.error('failed to sync commands:', error.message);
  }
  
  await backfillHistory();
  await updateVolumeCache();
  
  setInterval(updateVolumeCache, 5 * 60 * 1000);
});

process.on('unhandledRejection', (error) => {
  if (error.code === 10062) {
    console.log('interaction expired (button from before restart)');
  } else {
    console.error('unhandled rejection:', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'volume') {
        const mainEmbed = new EmbedBuilder()
          .setTitle('📊 Volume & Selling Pressure Dashboard')
          .setDescription('Green buttons = Top Volume | Red buttons = Top Selling Pressure (high volume dumps)')
          .setColor(0x3498db);
        
		const row1 = new ActionRowBuilder().addComponents(
		  new ButtonBuilder().setCustomId('volume_high_5m').setLabel('5m').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_15m').setLabel('15m').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_1h').setLabel('1h').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_4h').setLabel('4h').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_1d').setLabel('1d').setStyle(ButtonStyle.Success)
		);

		const row2 = new ActionRowBuilder().addComponents(
		  new ButtonBuilder().setCustomId('volume_sell_5m').setLabel('5m').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_sell_15m').setLabel('15m').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_sell_1h').setLabel('1h').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_sell_4h').setLabel('4h').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_sell_1d').setLabel('1d').setStyle(ButtonStyle.Danger)
		);
		
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [mainEmbed], components: [row1, row2] });
        }
      }
    }
    
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('volume_')) {
        const parts = interaction.customId.split('_');
        const volumeType = parts[1];
        const timeframe = parts[2];
        
        const data = volumeType === 'high' 
          ? volumeCache[timeframe]?.topVolume 
          : volumeCache[timeframe]?.sellingPressure;
        
        if (!data || data.length === 0) {
          if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({
              content: 'Data is still loading, please wait...',
              flags: MessageFlags.Ephemeral
            });
          }
          return;
        }
        
        const embed = createVolumeEmbed(timeframe, data, volumeType === 'high');
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ 
            embeds: [embed], 
            flags: MessageFlags.Ephemeral 
          });
        }
      }
    }
  } catch (error) {
    if (error.code === 10062 || error.code === 40060) {
      console.log('interaction expired (button too old or bot restarted)');
    } else if (error.message?.includes('Unknown interaction')) {
      console.log('interaction already handled or expired');
    } else {
      console.error('interaction error:', error.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
