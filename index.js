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
  topVolume: []
};

let lastUpdateTime = null;

const BYBIT_BASE = 'https://api.bybit.com';

async function fetchVolumeData() {
  const response = await axios.get(`${BYBIT_BASE}/v5/market/tickers`, {
    params: { category: 'linear' }
  });
  
  const volumeData = [];
  
  if (response.data?.result?.list) {
    response.data.result.list.forEach(ticker => {
      const symbol = ticker.symbol;
      const lastPriceStr = ticker.lastPrice;
      const volume24hStr = ticker.turnover24h;
      const priceChangeStr = ticker.price24hPcnt;
      
      if (symbol && lastPriceStr && volume24hStr) {
        const lastPrice = parseFloat(lastPriceStr);
        const volume24h = parseFloat(volume24hStr);
        const priceChange = parseFloat(priceChangeStr || 0) * 100;
        
        if (volume24h > 0) {
          volumeData.push({
            symbol,
            lastPrice,
            volume24h,
            priceChange
          });
        }
      }
    });
  }
  
  return volumeData;
}

async function updateVolumeCache() {
  console.log('\n' + '='.repeat(50));
  console.log(`updating volume data at ${new Date().toLocaleTimeString()}`);
  console.log('='.repeat(50));
  
  try {
    const allVolume = await fetchVolumeData();
    console.log(`fetched ${allVolume.length} contracts with volume data`);
    
    allVolume.sort((a, b) => b.volume24h - a.volume24h);
    
    volumeCache.topVolume = allVolume.slice(0, 20);
    
    lastUpdateTime = new Date();
    const topVol = volumeCache.topVolume[0];
    console.log(`✓ top volume: ${topVol.symbol} with $${(topVol.volume24h / 1000000).toFixed(2)}M`);
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

function createVolumeEmbed(title, data) {
  const lines = data.map((item, idx) => {
    const rank = (idx + 1).toString().padStart(2);
    
    let symbolDisplay = item.symbol.replace('USDT', '');
    if (symbolDisplay.endsWith('PERP')) {
      symbolDisplay = symbolDisplay.slice(0, -4);
    }
    symbolDisplay = symbolDisplay.padEnd(12);
    
    const priceStr = formatPrice(item.lastPrice).padEnd(12);
    const volumeStr = formatVolume(item.volume24h).padStart(10);
    
    const sign = item.priceChange >= 0 ? '+' : '';
    const changeEmoji = item.priceChange >= 0 ? '📈' : '📉';
    const changeStr = `${sign}${item.priceChange.toFixed(2)}%`;
    
    return `${rank}. ${symbolDisplay} ${priceStr} │ ${volumeStr} ${changeEmoji} ${changeStr}`;
  }).join('\n');
  
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription('```\n' + lines + '\n```')
    .setColor(0x3498db);
  
  if (lastUpdateTime) {
    const timeStr = lastUpdateTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    embed.setFooter({ text: `Powered by Bybit • Updates every 2min • Last update: ${timeStr}` });
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
      description: 'Show top 20 contracts by 24h trading volume'
    }
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log('✓ commands synced\n');
  } catch (error) {
    console.error('failed to sync commands:', error.message);
  }
  
  await updateVolumeCache();
  
  setInterval(updateVolumeCache, 2 * 60 * 1000);
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
          .setDescription('Click the button below to view the top 20 contracts by 24h trading volume')
          .setColor(0x3498db);
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('top_volume')
              .setLabel('Top 20 by Volume')
              .setStyle(ButtonStyle.Primary)
          );
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [mainEmbed], components: [row] });
        }
      }
    }
    
    if (interaction.isButton()) {
      if (interaction.customId === 'top_volume') {
        const data = volumeCache.topVolume;
        
        if (!data || data.length === 0) {
          if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({
              content: 'Data is still loading, please wait...',
              ephemeral: true
            });
          }
          return;
        }
        
        const embed = createVolumeEmbed('Top 20 Contracts by 24h Volume', data);
        
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
