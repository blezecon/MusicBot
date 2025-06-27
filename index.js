require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const YouTube = require('youtube-sr').default;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

const TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_VC_ID = process.env.VC_ID;

// Music system variables
let voiceConnection = null;
let audioPlayer = null;
let currentQueue = [];
let isPlaying = false;
let currentSong = null;
let isPaused = false;
let idleTimeout = null;

// Cache for better performance
const cache = {
  channels: new Map(),
  guilds: new Map(),
  ytdlInfo: new Map()
};

// Constants for better performance
const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const YTDL_OPTIONS = {
  filter: 'audioonly',
  quality: 'highestaudio',
  highWaterMark: 1 << 25,
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }
};

// Slash commands - Pre-built for efficiency
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube')
    .addStringOption(option =>
      option.setName('song')
        .setDescription('Song name or YouTube URL')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the music queue'),
  
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music and clear queue'),
  
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show currently playing song'),
  
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),
  
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),
  
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Make the bot leave the voice channel')
].map(command => command.toJSON());

// Optimized channel fetching with caching
async function getCachedChannel(channelId) {
  if (cache.channels.has(channelId)) {
    return cache.channels.get(channelId);
  }
  
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      cache.channels.set(channelId, channel);
    }
    return channel;
  } catch (error) {
    console.error(`❌ Error fetching channel ${channelId}:`, error.message);
    return null;
  }
}

// Fast voice channel validation
function checkSameVoiceChannel(interaction) {
  const userVoiceChannel = interaction.member?.voice?.channel;
  
  if (!userVoiceChannel) {
    return { allowed: false, message: '❌ You need to be in a voice channel to use this command!' };
  }
  
  if (!voiceConnection?.joinConfig?.channelId) {
    return { allowed: false, message: '❌ Bot is not connected to any voice channel!' };
  }
  
  if (userVoiceChannel.id !== voiceConnection.joinConfig.channelId) {
    return { allowed: false, message: '❌ You need to be in the same voice channel as the bot to use this command!' };
  }
  
  return { allowed: true };
}

// Optimized bot VC status check
function isBotInAnyVC() {
  return voiceConnection?.state?.status === VoiceConnectionStatus.Ready;
}

// Efficient disconnect handler
function handleVoiceDisconnect() {
  if (isPlaying || isPaused) {
    audioPlayer?.stop(true);
    isPlaying = false;
    isPaused = false;
    currentSong = null;
    currentQueue.length = 0; // Faster than = []
    console.log('⏹️ Stopped music and cleared queue due to VC disconnect.');
  }
  
  if (!idleTimeout) {
    startIdleTimeout();
  }
}

// Optimized voice connection setup
function setupVoiceConnectionListeners(connection) {
  if (!connection) return;

  // Remove all listeners at once for better performance
  connection.removeAllListeners();

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.log('🔌 Bot was disconnected from the voice channel.');
    handleVoiceDisconnect();
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log('🗑️ Voice connection was destroyed.');
    handleVoiceDisconnect();
  });

  connection.on('error', (error) => {
    console.error('Voice connection error:', error.message);
  });
}

// Optimized default VC joining
async function joinDefaultVC() {
  if (!DEFAULT_VC_ID) return;
  
  try {
    const channel = await getCachedChannel(DEFAULT_VC_ID);
    if (!channel) {
      console.error('❌ Default voice channel not found');
      return;
    }
    
    // Destroy existing connection efficiently
    if (voiceConnection) {
      voiceConnection.destroy();
    }
    
    voiceConnection = joinVoiceChannel({
      channelId: DEFAULT_VC_ID,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    setupVoiceConnectionListeners(voiceConnection);
    
    // Wait for connection to be ready with timeout
    try {
      await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
      console.log(`🔗 Joined default voice channel: ${channel.name}`);
    } catch (error) {
      console.error('❌ Failed to establish voice connection:', error.message);
      voiceConnection.destroy();
      voiceConnection = null;
    }
    
  } catch (error) {
    console.error('❌ Error joining default voice channel:', error.message);
  }
}

// Optimized timeout management
function startIdleTimeout() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
  }
  
  idleTimeout = setTimeout(async () => {
    console.log('⏰ Idle timeout reached.');
    if (!isBotInAnyVC()) {
      console.log('🔄 Not in any voice channel, returning to default VC');
      await joinDefaultVC();
    } else {
      console.log('✅ Still in a voice channel, not moving to default VC');
    }
  }, IDLE_TIMEOUT_MS);
  
  console.log('⏱️ Idle timeout started (2 minutes)');
}

function clearIdleTimeout() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
    idleTimeout = null;
    console.log('⏱️ Idle timeout cleared');
  }
}

// Optimized audio player initialization
function initializeAudioPlayer() {
  if (audioPlayer) {
    audioPlayer.removeAllListeners();
  }
  
  audioPlayer = createAudioPlayer();
  
  audioPlayer.on(AudioPlayerStatus.Playing, () => {
    isPlaying = true;
    isPaused = false;
    clearIdleTimeout();
    console.log(`🎵 Now Playing: ${currentSong?.title || 'Unknown'}`);
  });
  
  audioPlayer.on(AudioPlayerStatus.Paused, () => {
    isPaused = true;
    console.log('⏸️ Music paused');
  });
  
  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    console.log('🎵 Song finished');
    isPlaying = false;
    isPaused = false;
    
    // Use setImmediate for better performance
    setImmediate(() => {
      if (currentQueue.length > 0) {
        playNextSong();
      } else {
        console.log('📭 Queue is empty, starting idle timeout');
        startIdleTimeout();
      }
    });
  });
  
  audioPlayer.on('error', (error) => {
    console.error('🎵 Player error:', error.message);
    isPlaying = false;
    isPaused = false;
    
    setImmediate(() => {
      if (currentQueue.length > 0) {
        playNextSong();
      } else {
        startIdleTimeout();
      }
    });
  });
}

// Cached YouTube search with better error handling
async function searchYouTube(query) {
  try {
    const results = await YouTube.search(query, { 
      limit: 1, 
      type: 'video',
      requestOptions: {
        timeout: 10000 // 10 second timeout
      }
    });
    
    if (results?.[0]) {
      const video = results[0];
      return {
        title: video.title,
        url: video.url,
        duration: video.durationFormatted || 'N/A',
        thumbnail: video.thumbnail?.url || null
      };
    }
    return null;
  } catch (error) {
    console.error('YouTube search error:', error.message);
    return null;
  }
}

// Optimized song playing with better error handling
async function playNextSong() {
  if (currentQueue.length === 0) {
    currentSong = null;
    console.log('📭 Queue is empty');
    startIdleTimeout();
    return;
  }
  
  const song = currentQueue.shift();
  currentSong = song;
  
  console.log(`🎵 Attempting to play: ${song.title}`);
  
  try {
    const stream = ytdl(song.url, YTDL_OPTIONS);
    
    // Better error handling for streams
    stream.on('error', (error) => {
      console.error('❌ Stream error:', error.message);
      console.log('⏭️ Skipping to next song...');
      setImmediate(() => playNextSong());
    });
    
    const resource = createAudioResource(stream, {
      metadata: { title: song.title },
      inlineVolume: true
    });
    
    audioPlayer.play(resource);
    
    if (voiceConnection) {
      voiceConnection.subscribe(audioPlayer);
    }
    
  } catch (error) {
    console.error('❌ Error playing song:', error.message);
    setImmediate(() => playNextSong());
  }
}

// Optimized command registration
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  
  try {
    console.log('🔄 Registering commands...');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );

    console.log(`✅ Successfully registered ${commands.length} commands!`);
    
  } catch (error) {
    console.error('❌ Error registering commands:', error.message);
  }
}

// Bot ready event with optimizations
client.once('ready', async () => {
  console.log(`🤖 Bot is ready! Logged in as ${client.user.tag}`);
  console.log(`📝 Bot ID: ${client.user.id}`);
  
  initializeAudioPlayer();
  
  // Register commands and join VC in parallel
  await Promise.all([
    registerCommands(),
    new Promise(resolve => setTimeout(resolve, 3000)).then(() => joinDefaultVC())
  ]);
});

// Optimized interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const commandHandlers = {
    play: handlePlay,
    skip: handleSkip,
    queue: handleQueue,
    stop: handleStop,
    nowplaying: handleNowPlaying,
    pause: handlePause,
    resume: handleResume,
    leave: handleLeave
  };

  const handler = commandHandlers[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (error) {
    console.error('Command error:', error.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ 
        content: '❌ An error occurred while executing the command.', 
        ephemeral: true 
      }).catch(() => {});
    }
  }
});

// Optimized play handler with caching
async function handlePlay(interaction) {
  const song = interaction.options.getString('song');
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({ 
      content: '❌ You need to be in a voice channel to play music!', 
      ephemeral: true 
    });
  }

  if (isPlaying && voiceConnection?.joinConfig?.channelId !== voiceChannel.id) {
    return interaction.reply({ 
      content: '❌ Bot is currently playing music in another voice channel. Use `/stop` first.', 
      ephemeral: true 
    });
  }

  await interaction.deferReply();

  try {
    let songInfo;
    
    // Check if it's a YouTube URL
    if (/(?:youtube\.com\/watch\?v=|youtu\.be\/)/.test(song)) {
      // Check cache first
      if (cache.ytdlInfo.has(song)) {
        songInfo = cache.ytdlInfo.get(song);
      } else {
        const info = await ytdl.getInfo(song);
        songInfo = {
          title: info.videoDetails.title,
          url: song,
          duration: info.videoDetails.lengthSeconds ? 
            `${Math.floor(info.videoDetails.lengthSeconds / 60)}:${(info.videoDetails.lengthSeconds % 60).toString().padStart(2, '0')}` : 'N/A',
          thumbnail: info.videoDetails.thumbnails?.[0]?.url
        };
        // Cache the result
        cache.ytdlInfo.set(song, songInfo);
      }
    } else {
      songInfo = await searchYouTube(song);
      if (!songInfo) {
        return interaction.editReply('❌ No results found for your search.');
      }
    }

    clearIdleTimeout();

    // Optimized voice connection handling
    if (!voiceConnection || !isBotInAnyVC() || voiceConnection.joinConfig.channelId !== voiceChannel.id) {
      
      if (voiceConnection) {
        voiceConnection.destroy();
      }
      
      voiceConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      setupVoiceConnectionListeners(voiceConnection);
      
      try {
        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
        console.log(`🔗 Joined voice channel: ${voiceChannel.name}`);
      } catch (error) {
        console.error('❌ Failed to join voice channel:', error.message);
        return interaction.editReply('❌ Failed to join voice channel. Please try again.');
      }
    }

    currentQueue.push(songInfo);

    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('🎵 Song Added to Queue')
      .setDescription(`**${songInfo.title}**`)
      .addFields(
        { name: 'Duration', value: songInfo.duration, inline: true },
        { name: 'Position in Queue', value: `${currentQueue.length}`, inline: true }
      );

    if (songInfo.thumbnail) {
      embed.setThumbnail(songInfo.thumbnail);
    }

    await interaction.editReply({ embeds: [embed] });

    if (!isPlaying) {
      setImmediate(() => playNextSong());
    }

  } catch (error) {
    console.error('Play command error:', error.message);
    await interaction.editReply('❌ Error playing the song. Please try again.');
  }
}

// Optimized skip handler
async function handleSkip(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!isPlaying && !isPaused) {
    return interaction.reply({ content: '❌ No song is currently playing.', ephemeral: true });
  }

  const skippedSong = currentSong;
  audioPlayer.stop();
  
  const embed = new EmbedBuilder()
    .setColor('#ffff00')
    .setTitle('⏭️ Song Skipped')
    .setDescription(`Skipped: **${skippedSong?.title || 'Unknown'}**`);

  return interaction.reply({ embeds: [embed] });
}

// Optimized queue handler
async function handleQueue(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (currentQueue.length === 0 && !currentSong) {
    return interaction.reply({ content: '📭 The queue is empty.', ephemeral: true });
  }

  const queueStrings = [];
  
  if (currentSong) {
    queueStrings.push(`**Now Playing:** ${currentSong.title}\n`);
  }
  
  if (currentQueue.length > 0) {
    queueStrings.push('**Queue:**');
    currentQueue.slice(0, 10).forEach((song, index) => {
      queueStrings.push(`${index + 1}. ${song.title}`);
    });
    
    if (currentQueue.length > 10) {
      queueStrings.push(`... and ${currentQueue.length - 10} more songs`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('🎵 Music Queue')
    .setDescription(queueStrings.join('\n') || 'Queue is empty');

  return interaction.reply({ embeds: [embed] });
}

// Optimized stop handler
async function handleStop(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!isPlaying && !isPaused) {
    return interaction.reply({ content: '❌ No music is currently playing.', ephemeral: true });
  }

  audioPlayer.stop();
  currentQueue.length = 0;
  currentSong = null;
  isPlaying = false;
  isPaused = false;
  
  startIdleTimeout();

  const embed = new EmbedBuilder()
    .setColor('#ff0000')
    .setTitle('⏹️ Music Stopped')
    .setDescription('Stopped music and cleared the queue.');

  return interaction.reply({ embeds: [embed] });
}

// Optimized now playing handler
async function handleNowPlaying(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!currentSong) {
    return interaction.reply({ content: '❌ No song is currently playing.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setColor('#00ff00')
    .setTitle('🎵 Now Playing')
    .setDescription(`**${currentSong.title}**`)
    .addFields(
      { name: 'Status', value: isPaused ? '⏸️ Paused' : '▶️ Playing', inline: true },
      { name: 'Songs in Queue', value: `${currentQueue.length}`, inline: true }
    );

  if (currentSong.thumbnail) {
    embed.setThumbnail(currentSong.thumbnail);
  }

  return interaction.reply({ embeds: [embed] });
}

// Optimized pause handler
async function handlePause(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!isPlaying || isPaused) {
    return interaction.reply({ 
      content: isPaused ? '❌ Music is already paused.' : '❌ No song is currently playing.', 
      ephemeral: true 
    });
  }

  audioPlayer.pause();
  return interaction.reply({ content: '⏸️ Music paused.' });
}

// Optimized resume handler
async function handleResume(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!isPaused) {
    return interaction.reply({ content: '❌ Music is not paused.', ephemeral: true });
  }

  audioPlayer.unpause();
  clearIdleTimeout();
  return interaction.reply({ content: '▶️ Music resumed.' });
}

// Optimized leave handler
async function handleLeave(interaction) {
  const vcCheck = checkSameVoiceChannel(interaction);
  if (!vcCheck.allowed) {
    return interaction.reply({ content: vcCheck.message, ephemeral: true });
  }

  if (!voiceConnection) {
    return interaction.reply({ content: '❌ Bot is not in a voice channel.', ephemeral: true });
  }

  voiceConnection.destroy();
  voiceConnection = null;
  audioPlayer.stop();
  currentQueue.length = 0;
  currentSong = null;
  isPlaying = false;
  isPaused = false;
  clearIdleTimeout();

  // Use setImmediate instead of setTimeout for better performance
  setImmediate(() => {
    setTimeout(() => joinDefaultVC(), 1000);
  });

  return interaction.reply({ content: '👋 Left the voice channel and cleared the queue.' });
}

// Enhanced error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
});

// Login to Discord
client.login(TOKEN);