const { ethers } = require('ethers');
const { randomBytes } = require('crypto');
const Queue = require('bull');
const config = require('../config/config');
const MasterTableAbi = require('../blockchain/masterpokertable.json').abi;
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { mailService } = require('../microservices');
// Note: table.service requires this module too, so we avoid a top-level require
// to prevent circular initialization issues. We will require the module at
// runtime inside functions where needed.
// Configuration
const RPC_URL = config.POLYGON_URL;
const PRIVATE_KEY = config.PRIVATE_KEY;
const MasterPokerFactoryABI = require('../blockchain/masterpokertable.json').abi;
const mongoHelper = require('../models/customdb');

// Create provider and signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// Hash constants
const PAYMENT_DISTRIBUTION = ethers.keccak256(ethers.toUtf8Bytes('PAYMENT_DISTRIBUTION'));
const rakePercent = 2;

// Define the hash constants needed for our contract's signature verification

const TABLE_CREATION = ethers.keccak256(ethers.toUtf8Bytes('TABLE_CREATION'));
const walletFactoryAbi = require('./walletfactory.json').abi;
const { abi: polygonTokenContractABI } = require('./MyToken.json');
// Track used nonces to prevent replay attacks
const usedNonces = new Set();

// Track pending transactions for monitoring
const pendingTransactions = new Map();
// Withdrawal queue - REDIS ONLY
const withdrawalQueue = new Queue('withdrawals', {
  redis: {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
  },
  defaultJobOptions: {
    attempts: 3, // Reduced attempts for faster testing
    backoff: {
      type: 'exponential',
      delay: 5000, // Faster backoff
    },
    removeOnComplete: 100, // Keep fewer for testing
    removeOnFail: 100,
  },
});

const { findAvailableTableWithCooldown } = require('../utils/matchmakingHelper');

// Generate unique nonce
function generateNonce() {
  return '0x' + randomBytes(32).toString('hex');
}

// Redis health check
async function checkRedisHealth() {
  try {
    const result = await withdrawalQueue.client.ping();
    return result === 'PONG';
  } catch (error) {
    console.error('[BLOCKCHAIN] Redis health check failed:', error.message);
    return false;
  }
}

// ✅ MINIMAL: Queue withdrawal - NO DATABASE OPERATIONS
async function queueWithdrawal(userId, tableId, tableBlockchainId, amount, walletAddress, userEmail, username) {
  console.log('🚀 ~ queueWithdrawal ~ userEmail:', userEmail);
  console.log(`[BLOCKCHAIN] Queueing minimal withdrawal for user: ${username}, amount: ${amount}`);

  // Check Redis health first
  const redisHealthy = await checkRedisHealth();
  if (!redisHealthy) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Queue service is currently unavailable. Please try again later.'
    );
  }

  // Create unique job ID
  const jobId = `withdrawal-${userId}-${tableBlockchainId}-${amount}-${Date.now()}`;

  try {
    // Generate nonce
    const nonce = generateNonce();

    console.log(`[BLOCKCHAIN] Adding job to queue: ${jobId}`);

    // Add to queue - NO DATABASE OPERATIONS
    const job = await withdrawalQueue.add(
      {
        userId,
        tableId,
        tableBlockchainId,
        amount,
        walletAddress,
        nonce,
        userEmail,
        username,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        attempts: 3,
      }
    );

    console.log(`[BLOCKCHAIN] Successfully queued minimal withdrawal job ${job.id}`);
    await mailService.sendEmail({
      to: userEmail,
      subject: 'Withdrawal Queued',
      text: `Hi ${username}, your withdrawal of ${amount} USDT has been queued and will be processed shortly.`,
    });

    return {
      success: true,
      jobId: job.id,
      message: 'Minimal withdrawal queued successfully - no database operations',
    };
  } catch (error) {
    console.error(`[BLOCKCHAIN] Failed to queue minimal withdrawal: ${error.message}`);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to queue withdrawal: ${error.message}`);
  }
}

// ✅ MINIMAL: Process withdrawal - NO DATABASE OPERATIONS
withdrawalQueue.process(async job => {
  const { userId, tableBlockchainId, amount, walletAddress, nonce, username, userEmail } = job.data;
  console.log('🚀 ~ userEmail:', userEmail);

  const masterTableContractAddress = config.MASTER_POKER_TABLE_CONTRACT;

  console.log(`[BLOCKCHAIN] Processing minimal withdrawal job ${job.id}: ${amount} USDT for user ${userId}`);

  job.progress(10);

  // Validate inputs
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    console.error(`[BLOCKCHAIN] Invalid wallet address: ${walletAddress}`);
    throw new Error('Invalid wallet address');
  }

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    console.error(`[BLOCKCHAIN] Invalid amount: ${amount}`);
    throw new Error('Invalid amount');
  }

  job.progress(20);

  try {
    console.log(`[BLOCKCHAIN] Starting blockchain processing for ${amount} USDT to ${walletAddress}`);

    // Convert amount to blockchain units
    const amountInUnits = ethers.parseUnits(amount.toString(), 6); // USDT uses 6 decimals

    // Create distribution array
    const distributions = [
      {
        player: walletAddress,
        amount: amountInUnits,
      },
    ];

    job.progress(30);

    // ✅ CRITICAL: Verify table exists and has sufficient balance
    const masterTableContract = new ethers.Contract(masterTableContractAddress, MasterTableAbi, signer);
    
    try {
      const tableInfo = await masterTableContract.getTable(tableBlockchainId);
      const tableAddress = tableInfo.tableAddress || tableInfo[0];
      console.log(`[BLOCKCHAIN] Table ${tableBlockchainId} address: ${tableAddress}`);
      
      // Check table balance with retry logic for pending deposits
      const tokenContract = new ethers.Contract(config.USDT_TOKEN, polygonTokenContractABI, provider);
      let tableBalance = await tokenContract.balanceOf(tableAddress);
      let tableBalanceFormatted = ethers.formatUnits(tableBalance, 6);
      
      console.log(`[BLOCKCHAIN] Table balance: ${tableBalanceFormatted} USDT, Required: ${amount} USDT`);
      
      // ✅ If insufficient, wait 10 seconds and check again (deposits might be pending)
      if (parseFloat(tableBalanceFormatted) < parseFloat(amount)) {
        console.log(`[BLOCKCHAIN] Insufficient balance, waiting 10s for pending deposits...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Check again
        tableBalance = await tokenContract.balanceOf(tableAddress);
        tableBalanceFormatted = ethers.formatUnits(tableBalance, 6);
        console.log(`[BLOCKCHAIN] Table balance after wait: ${tableBalanceFormatted} USDT`);
        
        if (parseFloat(tableBalanceFormatted) < parseFloat(amount)) {
          throw new Error(`Insufficient table balance. Table has ${tableBalanceFormatted} USDT but needs ${amount} USDT`);
        }
      }
    } catch (tableError) {
      console.error(`[BLOCKCHAIN] Table verification failed: ${tableError.message}`);
      throw new Error(`Table ${tableBlockchainId} verification failed: ${tableError.message}`);
    }

    // Create signature
    console.log(`[BLOCKCHAIN] Creating signature for withdrawal`);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'uint256', 'tuple(address player, uint256 amount)[]', 'bytes32'],
      [masterTableContractAddress, PAYMENT_DISTRIBUTION, tableBlockchainId, distributions, nonce]
    );

    const messageHash = ethers.keccak256(encoded);
    const messageBytes = ethers.getBytes(messageHash);
    const signature = await signer.signMessage(messageBytes);

    job.progress(50);

    console.log(`[BLOCKCHAIN] Submitting transaction to blockchain`);
    console.log(`[BLOCKCHAIN] Params: tableId=${tableBlockchainId}, amount=${amount}, wallet=${walletAddress}`);

    // Submit to blockchain
    const tx = await masterTableContract.distributePaymentsViaProxy(tableBlockchainId, distributions, nonce, signature);

    job.progress(70);
    console.log(`[BLOCKCHAIN] Transaction submitted: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();

    job.progress(100);
    console.log(`[BLOCKCHAIN] Withdrawal successful for job ${job.id}: ${receipt.hash}`);
    console.log(`[BLOCKCHAIN] User ${username} received ${amount} USDT`);

    try {
      await mailService.sendEmail({
        to: userEmail,
        subject: 'Withdrawal Successful',
        text: `Hi ${username}, your withdrawal of ${amount} USDT has been successfully processed. Transaction Hash: ${receipt.hash}`,
      });
    } catch (emailError) {
      console.error(`[BLOCKCHAIN] Failed to send success email: ${emailError.message}`);
    }

    // Return success - NO DATABASE OPERATIONS
    return {
      success: true,
      transactionHash: receipt.hash,
      jobId: job.id,
      amount: amount,
      walletAddress: walletAddress,
      username: username,
    };
  } catch (error) {
    console.error(`[BLOCKCHAIN] Withdrawal failed for job ${job.id}: ${error.message}`);
    console.error(`[BLOCKCHAIN] Error details: ${error.stack}`);
    try {
      await mailService.sendEmail({
        to: userEmail,
        subject: 'Withdrawal Failed',
        text: `Hi ${username}, your withdrawal of ${amount} USDT failed. Our team has been notified and will investigate this issue.`,
      });
    } catch (emailError) {
      console.error(`[BLOCKCHAIN] Failed to send failure email: ${emailError.message}`);
    }
    // Just throw the error - NO DATABASE OPERATIONS
    throw new Error(`Minimal withdrawal failed: ${error.message}`);
  }
});

// Initialize minimal blockchain service
async function initMinimalBlockchainService() {
  console.log(`[BLOCKCHAIN] Initializing minimal blockchain service (Redis only)...`);

  try {
    // Check blockchain connection
    const network = await provider.getNetwork();
    console.log(`[BLOCKCHAIN] Connected to network: ${network.name} (chainId: ${network.chainId})`);

    // Check signer balance
    const balance = await provider.getBalance(signer.address);
    console.log(`[BLOCKCHAIN] Signer balance: ${ethers.formatEther(balance)} ETH`);

    if (balance < ethers.parseEther('0.01')) {
      console.warn(`[BLOCKCHAIN] WARNING: Low signer balance`);
    }

    // Check Redis health
    const redisHealthy = await checkRedisHealth();
    if (!redisHealthy) {
      console.error('[BLOCKCHAIN] WARNING: Redis health check failed');
      return false;
    }

    console.log('[BLOCKCHAIN] ✅ Minimal blockchain service initialized successfully');
    console.log('[BLOCKCHAIN] 🔥 NO DATABASE OPERATIONS - REDIS ONLY');

    return true;
  } catch (error) {
    console.error(`[BLOCKCHAIN] Failed to initialize: ${error.message}`);
    return false;
  }
}

// Queue status check
async function getQueueStatus() {
  try {
    const waiting = await withdrawalQueue.getWaiting();
    const active = await withdrawalQueue.getActive();
    const completed = await withdrawalQueue.getCompleted();
    const failed = await withdrawalQueue.getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      total: waiting.length + active.length + completed.length + failed.length,
    };
  } catch (error) {
    console.error('[BLOCKCHAIN] Error getting queue status:', error.message);
    return null;
  }
}

// Clear all jobs (for testing)
async function clearAllJobs() {
  try {
    console.log('[BLOCKCHAIN] Clearing all jobs...');

    await withdrawalQueue.empty();
    await withdrawalQueue.clean(0, 'completed');
    await withdrawalQueue.clean(0, 'failed');
    await withdrawalQueue.clean(0, 'active');

    console.log('[BLOCKCHAIN] ✅ All jobs cleared');
    return true;
  } catch (error) {
    console.error('[BLOCKCHAIN] Error clearing jobs:', error.message);
    return false;
  }
}

async function getBalance(walletAddress) {
  try {
    const polygonProvider = new ethers.JsonRpcProvider(config.POLYGON_URL);
    let tokenContractAddress = config.USDT_TOKEN;
    const contract = new ethers.Contract(tokenContractAddress, polygonTokenContractABI, polygonProvider);
    const balance = (await contract.balanceOf(walletAddress)).toString();
    return ethers.formatUnits(balance, 6);
  } catch (error) {
    throw new ApiError(500, `Failed to fetch balance: ${error.message}`);
  }
}


const findTableOrCreateThroughBlockchain = async (playerCount, tableTypeId, chipsInPlay, userAddress, userId = null) => {
  try {
    console.log(`🔍 Finding/Creating table for user: ${userAddress}, chips: ${chipsInPlay}`);

    // First, try to find existing table with vacancies (require at runtime to avoid circular init)
    const tableService = require('../services/table.service.js');
    let table = await tableService.findTableWithVacancies(playerCount, tableTypeId, userId);
    if (table) {
      console.log(`✅ Found existing table: ${table._id}, blockchain ID: ${table.tableBlockchainId}`);

      // Check if this is a pre-created table without blockchain ID
      if (!table.tableBlockchainId || !table.blockchainAddress) {
        console.log(`🔗 Pre-created table found without blockchain ID, creating blockchain table now...`);

        // Create blockchain table for this pre-created table
        const createResult = await createTableOnBlockchain(userAddress, rakePercent, chipsInPlay);

        if (!createResult.success) {
          console.error('❌ Failed to create blockchain table:', createResult.error);
          throw new Error(`Blockchain table creation failed: ${createResult.error}`);
        }

        console.log('🎯 Successfully created blockchain table:', {
          tableId: createResult.tableId,
          tableAddress: createResult.tableAddress,
        });

        // Update the database table with blockchain info
        const mongoHelper = require('../models/customdb');
        const updateResult = await mongoHelper.updateById(
          mongoHelper.COLLECTIONS.TABLES,
          table._id,
          {
            tableBlockchainId: createResult.tableId,
            blockchainAddress: createResult.tableAddress
          },
          mongoHelper.MODELS.TABLE
        );

        if (updateResult.success) {
          console.log(`✅ Updated table ${table._id} with blockchain info`);
          table.tableBlockchainId = createResult.tableId;
          table.blockchainAddress = createResult.tableAddress;
        } else {
          console.error(`❌ Failed to update table with blockchain info`);
          throw new Error('Failed to update table with blockchain info');
        }
      }

      // Transfer in background
      console.log(`⚡ Starting background transfer to table ${table._id}`);
      transferFromPoolToTable(userAddress, table.blockchainAddress, chipsInPlay).catch(err => {
        console.error(`❌ Transfer error: ${err.message}`);
      });

      return {
        table,
        isBlockchainEnabled: true,
        blockchainInfo: {},
        tableData: table,
        wasCreated: false,
        message: 'Joined existing table with funds transferred',
      };
    }

    // No existing table found, create new one
    console.log('🆕 No existing table found, creating new table...');

    // Create table on blockchain first
    const createResult = await createTableOnBlockchain(userAddress, rakePercent, chipsInPlay);

    if (!createResult.success) {
      console.error('❌ Failed to create table:', createResult.error);
      throw new Error(`Table creation failed: ${createResult.error}`);
    }

    console.log('🎯 Successfully created table on blockchain:', {
      tableId: createResult.tableId,
      tableAddress: createResult.tableAddress,
    });

    // Save new table to database
    // Require again to ensure we reference the fully-initialized module (safe and cheap at runtime)
    const tableService2 = require('../services/table.service.js');
    const newTable = await tableService2.createTable(playerCount, tableTypeId, createResult.tableId, createResult.tableAddress);

    console.log('💾 Table saved to database');
    
    // Transfer in background
    console.log(`⚡ Starting background transfer to new table ${newTable._id}`);
    transferFromPoolToTable(userAddress, createResult.tableAddress, chipsInPlay).catch(err => {
      console.error(`❌ Transfer error: ${err.message}`);
    });

    return {
      table: newTable,
      isBlockchainEnabled: true,
      blockchainInfo: {},
      tableData: newTable,
      wasCreated: true,
      message: 'Created new table with funds transferred',
    };
  } catch (error) {
    console.error('💥 Error in findTableOrCreateThroughBlockchain:', error);
    throw new Error(`Table operation failed: ${error.message}`);
  }
};


// Enhanced version that respects sub-tier boundaries
const findTableOrCreateThroughBlockchainNew = async (playerCount, tableTypeId, chipsInPlay, userAddress, subTierId = null, userId) => {
  try {
    console.log(`🔍 Finding/Creating table for user: ${userAddress}, subTier: ${subTierId}, chips: ${chipsInPlay}`);

    // If subTierId is provided, use sub-tier aware table finding
    if (subTierId) {
      console.log(`🎯 Using sub-tier aware table finding for: ${subTierId}`);
      
      // First, try to find existing table in SPECIFIC sub-tier
      let table = await findAvailableTableWithCooldown(userId, subTierId, tableTypeId);

      if (table?.cooldownConflict) {
        throw new ApiError(httpStatus.CONFLICT, 'Cooldown conflict with players at the table');
      }
      console.log(`🚀 ~ findTableOrCreateThroughBlockchainNew ~ table:`, table);
      if (table) {
        console.log(`✅ Found existing table in sub-tier ${subTierId}: ${table._id}, blockchain ID: ${table.tableBlockchainId}`);

        // Table exists, transfer funds from user's pool to table
        const transferResult = await transferFromPoolToTable(userAddress, table.blockchainAddress, chipsInPlay);

        if (!transferResult.success) {
          console.error('❌ Failed to transfer funds to existing table:', transferResult.error);
          throw new Error(`Fund transfer failed: ${transferResult.error}`);
        }

        const matchmakingService = require('./matchmaking.service.js');

        let matchmakeTable = await matchmakingService.updateMatchmakingTable(subTierId, table._id, userId);


        return {
          table,
          isBlockchainEnabled: true,
          blockchainInfo: {},
          tableData: table,
          wasCreated: false,
          currentPlayers: matchmakeTable.currentPlayerIds,
          message: `Joined existing table in sub-tier ${subTierId} with funds transferred`,
        };
      }

      // No existing table found in sub-tier, create new one
      console.log(`🆕 No existing table found in sub-tier ${subTierId}, creating new table...`);

      // Create table on blockchain first
      const createResult = await createTableOnBlockchain(userAddress, rakePercent, chipsInPlay);

      if (!createResult.success) {
        console.error('❌ Failed to create table:', createResult.error);
        throw new Error(`Table creation failed: ${createResult.error}`);
      }

      console.log('🎯 Successfully created table on blockchain:', {
        tableId: createResult.tableId,
        tableAddress: createResult.tableAddress,
      });

      // Save new table to database with sub-tier association
      const tableService = require('./table.service.js');
      const newTable = await tableService.createTableForSubTier(
        playerCount, 
        tableTypeId, 
        createResult.tableId, 
        createResult.tableAddress,
        subTierId,
        userId
      );

      console.log('💰 Transferring creator funds to new table...');
      const transferResult = await transferFromPoolToTable(userAddress, createResult.tableAddress, chipsInPlay);

      if (!transferResult.success) {
        console.error('❌ Failed to transfer creator funds to new table:', transferResult.error);
        throw new Error(`Creator fund transfer failed: ${transferResult.error}`);
      }

      console.log(`✅ Creator funds successfully transferred to new table in sub-tier ${subTierId}`);

      return {
        table: newTable,
        isBlockchainEnabled: true,
        blockchainInfo: {},
        tableData: newTable,
        wasCreated: true,
        message: `Created new table in sub-tier ${subTierId} with funds transferred`,
      };
    } else {
      // Fallback to original behavior if no subTierId provided
      console.log('⚠️ No subTierId provided, using legacy table finding');
      return await findTableOrCreateThroughBlockchain(playerCount, tableTypeId, chipsInPlay, userAddress);
    }
  } catch (error) {
    console.error('💥 Error in findTableOrCreateThroughBlockchain:', error);
    throw new Error(`Table operation failed: ${error.message}`);
  }
};

const createTableOnBlockchain = async (userAddress, rakePercentage, chipsInPlay, retryCount = 0) => {
  const MAX_RETRIES = 2;
  try {
    console.log(`🏗️ Creating table for ${userAddress} with ${rakePercentage}% rake`);

    const masterPokerTableContract = new ethers.Contract(
      config.MASTER_POKER_TABLE_CONTRACT,
      MasterPokerFactoryABI,
      signer
    );

    const tableIdBefore = await masterPokerTableContract.nextTableId();
    console.log('🆔 Next table ID:', tableIdBefore.toString());

    const { nonce, signature } = await signTableCreationRequest();
    const params = { rakePercentage, nonce, signature };

    console.log('⚡ Initiating table creation...');
    const txCreateTable = await masterPokerTableContract.createTableViaProxy(params);
    
    const tableId = tableIdBefore;
    const tableInfo = await masterPokerTableContract.getTable(tableId);
    const tableAddress = tableInfo.tableAddress || tableInfo[0];

    console.log(`⚡ Table created: ID=${tableId}, Address=${tableAddress}, Tx=${txCreateTable.hash}`);

    // Track and monitor in background
    pendingTransactions.set(txCreateTable.hash, { type: 'tableCreation', tableId, tableAddress, timestamp: Date.now() });
    
    txCreateTable.wait(1).then(receipt => {
      console.log(`✅ Table creation confirmed: ${receipt.hash}`);
      pendingTransactions.delete(txCreateTable.hash);
    }).catch(async err => {
      console.error(`❌ Table creation failed: ${err.message}`);
      pendingTransactions.delete(txCreateTable.hash);
      if (retryCount < MAX_RETRIES) {
        console.log(`🔄 Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return createTableOnBlockchain(userAddress, rakePercentage, chipsInPlay, retryCount + 1);
      }
    });

    return {
      success: true,
      tableId: tableId.toString(),
      tableAddress,
      txHash: txCreateTable.hash,
      pending: true
    };
  } catch (error) {
    console.error('❌ Table creation error:', error.message);
    if (retryCount < MAX_RETRIES) {
      console.log(`🔄 Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return createTableOnBlockchain(userAddress, rakePercentage, chipsInPlay, retryCount + 1);
    }
    return { success: false, error: error.message };
  }
};

const transferFromPoolToTable = async (userAddress, tableAddress, amount, retryCount = 0) => {
  const MAX_RETRIES = 2;
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`💸 [DEPOSIT] Starting transfer for user: ${userAddress}`);
    console.log(`💸 [DEPOSIT] Amount: ${amount} USDT`);
    console.log(`💸 [DEPOSIT] Table Address: ${tableAddress}`);
    console.log(`💸 [DEPOSIT] Retry Count: ${retryCount}/${MAX_RETRIES}`);
    console.log(`${'='.repeat(80)}\n`);

    const amountWei = ethers.parseUnits(amount.toString(), 6);
    const walletFactoryContract = new ethers.Contract(config.WALLET_FACTORY_ADDRESS, walletFactoryAbi, signer);
    const tokenContract = new ethers.Contract(config.USDT_TOKEN, polygonTokenContractABI, provider);

    // Check user pool balance BEFORE transfer
    console.log(`📊 [DEPOSIT] Checking user pool balance...`);
    const poolBalance = await walletFactoryContract.getPlayerBalance(userAddress);
    const poolBalanceNum = Number(ethers.formatUnits(poolBalance, 6));
    const requiredAmountNum = Number(amount);

    console.log(`💳 [DEPOSIT] User Pool Balance: ${poolBalanceNum} USDT`);
    console.log(`💳 [DEPOSIT] Required Amount: ${requiredAmountNum} USDT`);

    if (poolBalanceNum < requiredAmountNum) {
      const shortfall = (requiredAmountNum - poolBalanceNum).toFixed(2);
      console.error(`❌ [DEPOSIT] INSUFFICIENT POOL BALANCE - Need ${shortfall} more USDT`);
      throw new Error(`Insufficient pool balance. Need ${shortfall} more USDT`);
    }

    // Check table balance BEFORE transfer
    console.log(`📊 [DEPOSIT] Checking table balance BEFORE transfer...`);
    const tableBalanceBefore = await tokenContract.balanceOf(tableAddress);
    const tableBalanceBeforeFormatted = ethers.formatUnits(tableBalanceBefore, 6);
    console.log(`💰 [DEPOSIT] Table Balance BEFORE: ${tableBalanceBeforeFormatted} USDT`);

    console.log(`⚡ [DEPOSIT] Initiating blockchain transfer (async)...`);
    const tx = await walletFactoryContract.transferFromPoolToTable(userAddress, tableAddress, amountWei);
    console.log(`⚡ [DEPOSIT] Transaction submitted: ${tx.hash}`);
    console.log(`⚡ [DEPOSIT] Transaction is PENDING confirmation...`);

    // Track and monitor in background
    pendingTransactions.set(tx.hash, { type: 'transfer', userAddress, tableAddress, amount, timestamp: Date.now() });
    
    // Monitor transaction in background with detailed logging
    tx.wait(1).then(async receipt => {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ [DEPOSIT] Transaction CONFIRMED: ${receipt.hash}`);
      console.log(`✅ [DEPOSIT] Block Number: ${receipt.blockNumber}`);
      console.log(`✅ [DEPOSIT] Gas Used: ${receipt.gasUsed.toString()}`);
      
      // Verify table balance AFTER transfer
      try {
        console.log(`📊 [DEPOSIT] Verifying table balance AFTER transfer...`);
        const tableBalanceAfter = await tokenContract.balanceOf(tableAddress);
        const tableBalanceAfterFormatted = ethers.formatUnits(tableBalanceAfter, 6);
        const actualIncrease = parseFloat(tableBalanceAfterFormatted) - parseFloat(tableBalanceBeforeFormatted);
        
        console.log(`💰 [DEPOSIT] Table Balance AFTER: ${tableBalanceAfterFormatted} USDT`);
        console.log(`💰 [DEPOSIT] Expected Increase: ${amount} USDT`);
        console.log(`💰 [DEPOSIT] Actual Increase: ${actualIncrease.toFixed(6)} USDT`);
        
        if (Math.abs(actualIncrease - parseFloat(amount)) < 0.000001) {
          console.log(`✅ [DEPOSIT] VERIFICATION PASSED - Table balance increased correctly`);
        } else {
          console.error(`⚠️ [DEPOSIT] VERIFICATION WARNING - Balance increase mismatch!`);
        }
      } catch (verifyError) {
        console.error(`❌ [DEPOSIT] Balance verification failed: ${verifyError.message}`);
      }
      
      console.log(`${'='.repeat(80)}\n`);
      pendingTransactions.delete(tx.hash);
    }).catch(async err => {
      console.log(`\n${'='.repeat(80)}`);
      console.error(`❌ [DEPOSIT] Transaction FAILED: ${err.message}`);
      console.error(`❌ [DEPOSIT] Transaction Hash: ${tx.hash}`);
      console.error(`❌ [DEPOSIT] Error Details: ${err.stack}`);
      console.log(`${'='.repeat(80)}\n`);
      pendingTransactions.delete(tx.hash);
      
      if (retryCount < MAX_RETRIES) {
        console.log(`🔄 [DEPOSIT] Retrying transfer (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return transferFromPoolToTable(userAddress, tableAddress, amount, retryCount + 1);
      }
    });

    console.log(`✅ [DEPOSIT] Transfer initiated successfully (pending confirmation)`);
    console.log(`📝 [DEPOSIT] Monitor logs above for confirmation status\n`);
    
    return { success: true, txHash: tx.hash, amount, pending: true };
  } catch (error) {
    console.log(`\n${'='.repeat(80)}`);
    console.error(`❌ [DEPOSIT] Transfer error: ${error.message}`);
    console.error(`❌ [DEPOSIT] Stack: ${error.stack}`);
    console.log(`${'='.repeat(80)}\n`);
    return { success: false, error: error.message };
  }
};

async function signTableCreationRequest() {
  const nonce = generateNonce();

  const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'uint256', 'bytes32'],
    [config.MASTER_POKER_TABLE_CONTRACT, TABLE_CREATION, rakePercent, nonce]
  );

  const messageHash = ethers.keccak256(encodedData);
  const signature = await signer.signMessage(ethers.getBytes(messageHash));

  usedNonces.add(nonce);
  return { nonce, signature };
}

const prepareTableForJoin = async (table, chipsInPlay, userAddress) => {
  try {
    console.log(`🎯 Preparing table for join: ${table._id}, blockchain ID: ${table.tableBlockchainId}`);
    
    // Check if table has blockchain info, if not create it
    if (!table.tableBlockchainId || !table.blockchainAddress) {
      console.log(`🔗 Table found without blockchain ID, creating blockchain table now...`);
      
      const createResult = await createTableOnBlockchain(userAddress, rakePercent, chipsInPlay);
      
      if (!createResult.success) {
        console.error('❌ Failed to create blockchain table:', createResult.error);
        throw new Error(`Blockchain table creation failed: ${createResult.error}`);
      }
      
      console.log('🎯 Successfully created blockchain table:', {
        tableId: createResult.tableId,
        tableAddress: createResult.tableAddress,
      });
      
      // Update the database table with blockchain info
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TABLES,
        table._id,
        {
          tableBlockchainId: createResult.tableId,
          blockchainAddress: createResult.tableAddress
        },
        mongoHelper.MODELS.TABLE
      );
      
      if (updateResult.success) {
        console.log(`✅ Updated table ${table._id} with blockchain info`);
        table.tableBlockchainId = createResult.tableId;
        table.blockchainAddress = createResult.tableAddress;
      } else {
        console.error(`❌ Failed to update table with blockchain info`);
        throw new Error('Failed to update table with blockchain info');
      }
    }
    
    // Transfer in background
    console.log(`⚡ Starting background transfer for table ${table._id}`);
    transferFromPoolToTable(userAddress, table.blockchainAddress, chipsInPlay).catch(err => {
      console.error(`❌ Transfer error for table ${table._id}: ${err.message}`);
    });
    
    return { success: true, table, transferPending: true };
  } catch (error) {
    console.error('💥 Error in prepareTableForJoin:', error);
    throw new Error(`Failed to prepare table: ${error.message}`);
  }
};


// Get pending transactions status
function getPendingTransactions() {
  const pending = [];
  const now = Date.now();
  for (const [txHash, data] of pendingTransactions.entries()) {
    pending.push({
      txHash,
      ...data,
      age: Math.floor((now - data.timestamp) / 1000)
    });
  }
  return pending;
}

// Export minimal functions
module.exports = {
  initMinimalBlockchainService,
  queueWithdrawal,
  withdrawalQueue,
  generateNonce,
  checkRedisHealth,
  getQueueStatus,
  clearAllJobs,
  getBalance,
  findTableOrCreateThroughBlockchain,
  signTableCreationRequest,
  transferFromPoolToTable,
  createTableOnBlockchain,
  prepareTableForJoin,
  getPendingTransactions,
  findTableOrCreateThroughBlockchainNew
};
