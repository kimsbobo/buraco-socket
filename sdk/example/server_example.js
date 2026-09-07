/**
 * Brazilia SDK - Node.js Example
 * 
 * Demonstrates how to use the Brazilia SDK in a Node.js application
 */

const { BraziliaSDK } = require('../sdk');

async function main() {
  console.log('=== Brazilia SDK Node.js Example ===\n');
  
  // Create SDK instance
  const sdk = new BraziliaSDK({
    port: 8080,
    host: '0.0.0.0',
    enableEvents: true,
  });
  
  // Setup event listeners
  setupEventListeners(sdk);
  
  // Start the server
  console.log('🚀 Starting Brazilia SDK server...\n');
  await sdk.start();
  
  console.log('✅ Server is running!');
  console.log('📡 Listening on port 8080');
  console.log('🎮 Ready to accept connections\n');
  
  // Monitor stats every 10 seconds
  setInterval(() => {
    printStats(sdk);
  }, 10000);
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    await sdk.stop();
    process.exit(0);
  });
}

function setupEventListeners(sdk) {
  console.log('=== Setting up event listeners ===\n');
  
  // Game started event
  sdk.on('game.started', (event) => {
    console.log('🎮 GAME STARTED');
    console.log(`  Game ID: ${event.gameId}`);
    console.log(`  Players: ${event.players.map(p => p.name).join(', ')}`);
    console.log(`  Time: ${event.timestamp}\n`);
    
    // Example: Save to database
    // await database.games.insert({
    //   gameId: event.gameId,
    //   players: event.players,
    //   startedAt: new Date(event.timestamp),
    //   status: 'in_progress',
    // });
  });
  
  // Game completed event
  sdk.on('game.completed', (event) => {
    console.log('🏆 GAME COMPLETED');
    console.log(`  Game ID: ${event.gameId}`);
    console.log(`  Winner: ${event.winner.name} with ${event.winner.score} points`);
    console.log(`  Duration: ${event.duration}`);
    console.log('  Final scores:');
    event.players.forEach(player => {
      const emoji = player.id === event.winner.id ? '👑' : '  ';
      console.log(`    ${emoji} ${player.name}: ${player.score} points`);
    });
    console.log('');
    
    // Example: Update database
    // await database.games.update(
    //   { gameId: event.gameId },
    //   {
    //     status: 'completed',
    //     winner: event.winner,
    //     finalScores: event.players,
    //     duration: event.duration,
    //     completedAt: new Date(event.timestamp),
    //   }
    // );
    
    // Example: Update player stats
    // for (const player of event.players) {
    //   await database.players.update(
    //     { playerId: player.id },
    //     {
    //       $inc: {
    //         gamesPlayed: 1,
    //         totalScore: player.score,
    //         wins: player.id === event.winner.id ? 1 : 0,
    //       }
    //     }
    //   );
    // }
    
    // Example: Send to webhook
    // sendWebhook('https://yourapp.com/webhooks/game-completed', event);
  });
  
  // Player status event
  sdk.on('player.status', (event) => {
    const statusEmoji = event.status === 'connected' ? '✅' : '❌';
    console.log(`${statusEmoji} Player ${event.playerName} is ${event.status}`);
    console.log(`  Game ID: ${event.gameId}`);
    console.log(`  Time: ${event.timestamp}\n`);
    
    // Example: Log to analytics
    // analytics.track('player_status_changed', {
    //   playerId: event.playerId,
    //   status: event.status,
    //   gameId: event.gameId,
    //   timestamp: event.timestamp,
    // });
  });
  
  // Turn played event
  sdk.on('turn.played', (event) => {
    console.log(`🎯 Turn played in game ${event.gameId}`);
    console.log(`  Player: ${event.playerIndex}`);
    console.log(`  Action: ${event.action}\n`);
  });
}

function printStats(sdk) {
  const stats = sdk.getStats();
  
  console.log('📊 SDK Statistics:');
  console.log(`  Active games: ${stats.activeRooms}`);
  console.log(`  Total players: ${stats.totalPlayers}`);
  console.log(`  Uptime: ${formatUptime(stats.uptime)}`);
  console.log('');
  
  // Print active games
  const games = sdk.getActiveGames();
  if (games.length > 0) {
    console.log('🎮 Active Games:');
    games.forEach(game => {
      console.log(`  ${game.gameId}: ${game.playerCount}/${game.maxPlayers} players (${game.status})`);
    });
    console.log('');
  }
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}

// Example: Webhook integration
async function sendWebhook(url, data) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    
    if (response.ok) {
      console.log(`✅ Webhook delivered to ${url}`);
    } else {
      console.error(`❌ Webhook failed: ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Webhook error:`, error.message);
  }
}

// Example: Express.js integration
function setupExpressIntegration(sdk) {
  const express = require('express');
  const app = express();
  
  app.use(express.json());
  
  // Get game state
  app.get('/api/games/:gameId', (req, res) => {
    try {
      const state = sdk.getGameState(req.params.gameId);
      res.json({ success: true, data: state });
    } catch (error) {
      res.status(404).json({ success: false, error: error.message });
    }
  });
  
  // List active games
  app.get('/api/games', (req, res) => {
    const games = sdk.getActiveGames();
    res.json({ success: true, data: games });
  });
  
  // Get statistics
  app.get('/api/stats', (req, res) => {
    const stats = sdk.getStats();
    res.json({ success: true, data: stats });
  });
  
  // End game (admin endpoint)
  app.post('/api/games/:gameId/end', (req, res) => {
    try {
      const { winnerId } = req.body;
      sdk.endGame(req.params.gameId, winnerId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });
  
  // Webhook endpoint (example for receiving events from other services)
  app.post('/webhooks/game-events', (req, res) => {
    const event = req.body;
    console.log('📨 Webhook received:', event.event);
    
    // Process the event
    // ... your logic here ...
    
    res.json({ success: true });
  });
  
  app.listen(3000, () => {
    console.log('🌐 Express API listening on port 3000');
  });
}

// Run the example
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
