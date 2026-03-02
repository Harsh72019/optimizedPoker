
const {create , find} = require('../models/customdb.js');

async function seedBots() {

  const bots = [
    { username: 'MightyThor', email: 'bot1@pokerai.local', password: 'bot@1234', isBot: true },
    { username: 'SuperSimp', email: 'bot2@pokerai.local', password: 'bot@1234', isBot: true },
    { username: 'AlphaWrecker', email: 'bot3@pokerai.local', password: 'bot@1234', isBot: true },
    { username: 'DeltaForce', email: 'bot4@pokerai.local', password: 'bot@1234', isBot: true },
  ];

  for (const bot of bots) {
    const existing = await find('users' , { email: bot.email });
    console.log(existing);
    if (existing.data.length > 0) {
      console.log(`Bot with email ${bot.email} already exists.`);
    }
    else {
      await create('users' , bot);
      console.log(`Created bot: ${bot.username}`);
    }
  }

}

seedBots().catch(err => {
  console.error(err);
});

module.exports = seedBots;
