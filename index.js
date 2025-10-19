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
  '5m': { topVolume: [], lowVolume: [] },
  '15m': { topVolume: [], lowVolume: [] },
  '1h': { topVolume: [], lowVolume: [] },
  '4h': { topVolume: [], lowVolume: [] },
  '1d': { topVolume: [], lowVolume: [] }
};

let lastUpdateTime = null;

const BYBIT_BASE = 'https://api.bybit.com';

async function fetchVolumeData(timeframe) {
  const response = await axios.get(`${BYBIT_BASE}/v5/market/tickers`, {
    params: { category: 'linear' }
  });
  
  const volumeData = [];
  
  if (response.data?.result?.list) {
    const perpetualSymbols = response.data.result.list
      .filter(t => {
        if (!t.symbol || !t.lastPrice) return false;
        if (!t.symbol.endsWith('USDT') && !t.symbol.endsWith('PERP')) return false;
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
          
          const intervalMap = {
            '5m': { interval: '1', limit: 5 },     
            '15m': { interval: '5', limit: 3 },     
            '1h': { interval: '15', limit: 4 },   
            '4h': { interval: '60', limit: 4 },   
            '1d': { interval: 'D', limit: 1 }
          };
          
          const config = intervalMap[timeframe];
          
          const klineResponse = await axios.get(`${BYBIT_BASE}/v5/market/kline`, {
            params: {
              category: 'linear',
              symbol: symbol,
              interval: config.interval,
              limit: config.limit
            }
          });
          
          if (klineResponse.data?.result?.list && klineResponse.data.result.list.length >= config.limit) {
            const volumeTimeframe = klineResponse.data.result.list.reduce((sum, candle) => {
              return sum + parseFloat(candle[6]);
            }, 0);
            
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
      
      volumeCache[tf].topVolume = volumeData.slice(0, 10);
      volumeCache[tf].lowVolume = volumeData.slice(-10).reverse(); // lowest 10, reversed
      
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

function createVolumeEmbed(timeframe, data, isHighVolume) {
  const title = isHighVolume 
    ? `Top 10 Volume (${timeframe})`
    : `Top 10 Lowest Volume (${timeframe})`;
  
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
      description: 'Show top 10 highest and lowest volume contracts for different timeframes'
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
          .setTitle('📊 Top Volume Dashboard')
          .setDescription('Click a timeframe below to view the Top Volume for USDT perpetual contracts.')
          .setColor(0x3498db);
        
		const row1 = new ActionRowBuilder().addComponents(
		  new ButtonBuilder().setCustomId('volume_high_5m').setLabel('5m').setStyle(ButtonStyle.Success), // green
		  new ButtonBuilder().setCustomId('volume_high_15m').setLabel('15m').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_1h').setLabel('1h').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_4h').setLabel('4h').setStyle(ButtonStyle.Success),
		  new ButtonBuilder().setCustomId('volume_high_1d').setLabel('1d').setStyle(ButtonStyle.Success)
		);

		const row2 = new ActionRowBuilder().addComponents(
		  new ButtonBuilder().setCustomId('volume_low_5m').setLabel('5m').setStyle(ButtonStyle.Danger), // red
		  new ButtonBuilder().setCustomId('volume_low_15m').setLabel('15m').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_low_1h').setLabel('1h').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_low_4h').setLabel('4h').setStyle(ButtonStyle.Danger),
		  new ButtonBuilder().setCustomId('volume_low_1d').setLabel('1d').setStyle(ButtonStyle.Danger)
		);
		
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [mainEmbed], components: [row1, row2] });
        }
      }
    }
    
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('volume_')) {
        const parts = interaction.customId.split('_');
        const volumeType = parts[1]; //
        const timeframe = parts[2]; //
        
        const data = volumeType === 'high' 
          ? volumeCache[timeframe]?.topVolume 
          : volumeCache[timeframe]?.lowVolume;
        
        if (!data || data.length === 0) {
          if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({
              content: 'Data is still loading, please wait...',
              ephemeral: true
            });
          }
          return;
        }
        
        const embed = createVolumeEmbed(timeframe, data, volumeType === 'high');
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [embed], ephemeral: true });
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
