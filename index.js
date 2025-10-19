require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.on('error', (error) => {
  console.error('client error:', error.message);
});

const volumeCache = {
  '5m': [],
  '15m': [],
  '1h': [],
  '4h': [],
  '1d': []
};

let lastUpdateTime = null;

const BYBIT_BASE = 'https://api.bybit.com';

async function fetchVolumeData(timeframe) {
  const response = await axios.get(`${BYBIT_BASE}/v5/market/tickers`, {
    params: { category: 'linear' }
  });
  
  const volumeData = [];
  
  if (response.data?.result?.list) {
    // get kline data to calculate volume for specific timeframe
    const symbols = response.data.result.list
      .filter(t => t.symbol && t.lastPrice)
      .map(t => t.symbol);
    
    // process in batches to avoid overwhelming the api
    const batchSize = 50;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      const promises = batch.map(async symbol => {
        try {
          const ticker = response.data.result.list.find(t => t.symbol === symbol);
          const lastPrice = parseFloat(ticker.lastPrice);
          const priceChange = parseFloat(ticker.price24hPcnt || 0) * 100;
          
          // get volume for specific timeframe using klines
          const intervalMap = {
            '5m': '1',
            '15m': '5',
            '1h': '15',
            '4h': '60',
            '1d': '240'
          };
          
          const klineResponse = await axios.get(`${BYBIT_BASE}/v5/market/kline`, {
            params: {
              category: 'linear',
              symbol: symbol,
              interval: intervalMap[timeframe],
              limit: 1
            }
          });
          
          if (klineResponse.data?.result?.list?.[0]) {
            const kline = klineResponse.data.result.list[0];
            const volumeTimeframe = parseFloat(kline[5]); // volume in quote currency
            
            return {
              symbol,
              lastPrice,
              volumeTimeframe,
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
      volumeCache[tf] = volumeData.slice(0, 10);
      
      console.log(`✓ ${tf} updated - ${volumeData.length} contracts`);
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

function createVolumeEmbed(timeframe, data) {
  const lines = data.map((item) => {
    let symbolDisplay = item.symbol.replace('USDT', '');
    if (symbolDisplay.endsWith('PERP')) {
      symbolDisplay = symbolDisplay.slice(0, -4);
    }
    symbolDisplay = symbolDisplay.padEnd(12);
    
    const priceStr = formatPrice(item.lastPrice).padEnd(12);
    const volumeStr = formatVolume(item.volumeTimeframe);
    
    return `${symbolDisplay} ${priceStr} 📊 ${volumeStr}`;
  }).join('\n');
  
  const embed = new EmbedBuilder()
    .setTitle(`Top 10 Volume (${timeframe})`)
    .setDescription('```\n' + lines + '\n```')
    .setColor(0x3498db);
  
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
      description: 'Show top 10 contracts by trading volume for different timeframes'
    }
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log('✓ commands synced\n');
  } catch (error) {
    console.error('failed to sync commands:', error.message);
  }
  
  await updateVolumeCache();
  
  setInterval(updateVolumeCache, 5 * 60 * 1000);
});

process.on('unhandledRejection', (error) => {
  if (error.code === 10062) {
    console.log('⚠ interaction expired (button from before restart)');
  } else {
    console.error('unhandled rejection:', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'volume') {
        const mainEmbed = new EmbedBuilder()
          .setTitle('📊 Top Volume Dashboard')
          .setDescription('Click a timeframe below to view the Top Volume for USDT perpetual contracts.\n\n**Powered By Bybit**')
          .setColor(0x3498db);
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('volume_5m').setLabel('5m').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('volume_15m').setLabel('15m').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('volume_1h').setLabel('1h').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('volume_4h').setLabel('4h').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('volume_1d').setLabel('1d').setStyle(ButtonStyle.Primary)
          );
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [mainEmbed], components: [row] });
        }
      }
    }
    
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('volume_')) {
        const timeframe = interaction.customId.replace('volume_', '');
        const data = volumeCache[timeframe];
        
        if (!data || data.length === 0) {
          if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({
              content: '⏳ Data is still loading, please wait...',
              ephemeral: true
            });
          }
          return;
        }
        
        const embed = createVolumeEmbed(timeframe, data);
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      }
    }
  } catch (error) {
    if (error.code === 10062 || error.code === 40060) {
      console.log('⚠ interaction expired (button too old or bot restarted)');
    } else if (error.message?.includes('Unknown interaction')) {
      console.log('⚠ interaction already handled or expired');
    } else {
      console.error('interaction error:', error.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
