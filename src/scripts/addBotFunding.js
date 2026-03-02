const mongoHelper = require('./src/models/customdb');

async function addBotFunding() {
  try {
    // Get all tiers
    const tiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.TIERS);
    const tiers = tiersResult.data || [];
    
    if (tiers.length === 0) {
      console.log('❌ No tiers found. Run matchmaking initialization first.');
      process.exit(1);
    }

    // Add 1,000,000 chips to each tier's reserve
    for (const tier of tiers) {
      const fundingAmount = 1000000;
      
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TIERS,
        tier._id,
        { 
          bankAllocatedReserve: fundingAmount,
          'botConcession.enable': true,
          'botConcession.minWaitToConcedeSecs': 10,
          'botConcession.minPlayerReputation': 10
        }
      );
      
      console.log(`✅ Added ${fundingAmount} chips to ${tier.name} reserve`);
    }
    
    console.log('\n✅ Bot funding added successfully!');
    console.log('Players will now get bot concession after 10 seconds in queue');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

addBotFunding();
