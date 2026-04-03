const mongoHelper = require('../models/customdb');
const blockchainService = require('./blockchain.service');

class WalletIntegrationService {
  
  /**
   * Charge setup fee from host wallet using blockchain
   */
  async chargeSetupFee(hostId, amount, gameId) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('Host not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('Host wallet address not found');
      }
      
      // Get current blockchain balance from user's pool using existing service
      const currentBalance = await this.getPoolBalance(user.walletAddress);
      
      // Check sufficient balance
      if (parseFloat(currentBalance) < amount) {
        throw new Error(`Insufficient pool balance. Required: ${amount}, Available: ${currentBalance}`);
      }
      
      // Transfer setup fee from user's pool to platform using existing blockchain service
      const transferResult = await this.transferSetupFeeFromPool(user.walletAddress, amount);
      
      if (!transferResult.success) {
        throw new Error(`Setup fee transfer failed: ${transferResult.error}`);
      }
      
      // Log transaction with blockchain hash
      await this.logTransaction({
        userId: hostId,
        type: 'SETUP_FEE_CHARGE',
        amount: -amount,
        gameId,
        description: `Setup fee for game ${gameId}`,
        walletAddress: user.walletAddress,
        blockchainTxHash: transferResult.txHash
      });
      
      console.log(`💰 Setup fee charged via blockchain: ${amount} from host ${hostId}`);
      console.log(`🔗 Transaction hash: ${transferResult.txHash}`);
      
      return {
        success: true,
        chargedAmount: amount,
        walletAddress: user.walletAddress,
        transactionId: `setup_${gameId}_${Date.now()}`,
        blockchainTxHash: transferResult.txHash,
        blockchainPending: transferResult.pending || false
      };
      
    } catch (error) {
      console.error(`❌ Setup fee charge failed:`, error);
      throw error;
    }
  }
  
  /**
   * Get user's pool balance using existing blockchain service
   */
  async getPoolBalance(walletAddress) {
    try {
      const { ethers } = require('ethers');
      const config = require('../config/config');
      const walletFactoryAbi = require('../services/walletfactory.json').abi;
      
      const provider = new ethers.JsonRpcProvider(config.POLYGON_URL);
      const walletFactoryContract = new ethers.Contract(config.WALLET_FACTORY_ADDRESS, walletFactoryAbi, provider);
      
      const poolBalance = await walletFactoryContract.getPlayerBalance(walletAddress);
      return ethers.formatUnits(poolBalance, 6); // USDT has 6 decimals
    } catch (error) {
      console.error(`❌ Failed to get pool balance:`, error);
      throw new Error(`Failed to get pool balance: ${error.message}`);
    }
  }
  
  /**
   * Transfer setup fee using existing blockchain service transfer mechanism
   */
  async transferSetupFeeFromPool(userWalletAddress, amount) {
    try {
      const config = require('../config/config');
      
      // Use master poker table contract as platform wallet (same as existing pattern)
      const platformWalletAddress = config.MASTER_POKER_TABLE_CONTRACT;
      
      console.log(`💸 [SETUP_FEE] Using existing blockchain service for transfer`);
      console.log(`💸 [SETUP_FEE] Amount: ${amount} USDT`);
      console.log(`💸 [SETUP_FEE] From: ${userWalletAddress}`);
      console.log(`💸 [SETUP_FEE] To: ${platformWalletAddress}`);
      
      // Use existing blockchain service transfer function
      const transferResult = await blockchainService.transferFromPoolToTable(
        userWalletAddress, 
        platformWalletAddress, 
        amount
      );
      
      if (transferResult.success) {
        console.log(`✅ [SETUP_FEE] Transfer successful: ${transferResult.txHash}`);
        return {
          success: true,
          txHash: transferResult.txHash,
          amount: amount,
          pending: transferResult.pending || false
        };
      } else {
        console.error(`❌ [SETUP_FEE] Transfer failed: ${transferResult.error}`);
        return {
          success: false,
          error: transferResult.error
        };
      }
      
    } catch (error) {
      console.error(`❌ [SETUP_FEE] Transfer error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Pay host reward
   */
  async payHostReward(hostId, amount, gameId) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('Host not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('Host wallet address not found');
      }
      
      // TODO: Implement blockchain transfer for host reward
      // This should transfer tokens from platform wallet to host wallet
      console.log(`💰 Host reward should be paid via blockchain: ${amount} to host ${hostId}`);
      
      // Log transaction
      await this.logTransaction({
        userId: hostId,
        type: 'HOST_REWARD',
        amount: amount,
        gameId,
        description: `Host reward for game ${gameId}`,
        walletAddress: user.walletAddress,
        blockchainTxHash: null // Will be populated when blockchain integration is complete
      });
      
      console.log(`💰 Host reward logged: ${amount} to host ${hostId}`);
      
      return {
        success: true,
        paidAmount: amount,
        walletAddress: user.walletAddress,
        transactionId: `host_reward_${gameId}_${Date.now()}`,
        blockchainPending: true
      };
      
    } catch (error) {
      console.error(`❌ Host reward payment failed:`, error);
      throw error;
    }
  }
  
  /**
   * Pay affiliate commission
   */
  async payAffiliateCommission(affiliateId, amount, gameId, referredUserId) {
    try {
      const affiliateResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, affiliateId);
      
      if (!affiliateResult.success || !affiliateResult.data) {
        throw new Error('Affiliate not found');
      }
      
      const affiliate = affiliateResult.data;
      
      if (!affiliate.walletAddress) {
        throw new Error('Affiliate wallet address not found');
      }
      
      // TODO: Implement blockchain transfer for affiliate commission
      // This should transfer tokens from platform wallet to affiliate wallet
      console.log(`💰 Affiliate commission should be paid via blockchain: ${amount} to affiliate ${affiliateId}`);
      
      // Log transaction
      await this.logTransaction({
        userId: affiliateId,
        type: 'AFFILIATE_COMMISSION',
        amount: amount,
        gameId,
        description: `Affiliate commission for game ${gameId} (referred user: ${referredUserId})`,
        walletAddress: affiliate.walletAddress,
        blockchainTxHash: null, // Will be populated when blockchain integration is complete
        metadata: { referredUserId }
      });
      
      console.log(`💰 Affiliate commission logged: ${amount} to affiliate ${affiliateId}`);
      
      return {
        success: true,
        paidAmount: amount,
        walletAddress: affiliate.walletAddress,
        transactionId: `affiliate_${gameId}_${Date.now()}`,
        blockchainPending: true
      };
      
    } catch (error) {
      console.error(`❌ Affiliate commission payment failed:`, error);
      throw error;
    }
  }
  
  /**
   * Distribute prize pool to winners
   */
  async distributePrizePool(winners, gameId) {
    const results = [];
    
    for (const winner of winners) {
      try {
        const { userId, amount, position } = winner;
        
        const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
        
        if (!userResult.success || !userResult.data) {
          console.error(`❌ Winner not found: ${userId}`);
          results.push({
            userId,
            position,
            amount,
            success: false,
            error: 'User not found'
          });
          continue;
        }
        
        const user = userResult.data;
        
        if (!user.walletAddress) {
          console.error(`❌ Winner wallet address not found: ${userId}`);
          results.push({
            userId,
            position,
            amount,
            success: false,
            error: 'Wallet address not found'
          });
          continue;
        }
        
        // TODO: Implement blockchain transfer for prize payout
        // This should transfer tokens from platform/table wallet to winner wallet
        console.log(`🏆 Prize should be paid via blockchain: ${amount} to winner ${userId}`);
        
        // Log transaction
        await this.logTransaction({
          userId,
          type: 'PRIZE_PAYOUT',
          amount: amount,
          gameId,
          description: `Prize payout for position ${position} in game ${gameId}`,
          walletAddress: user.walletAddress,
          blockchainTxHash: null, // Will be populated when blockchain integration is complete
          metadata: { position }
        });
        
        results.push({
          userId,
          position,
          amount,
          success: true,
          walletAddress: user.walletAddress,
          transactionId: `prize_${gameId}_${userId}_${Date.now()}`,
          blockchainPending: true
        });
        
        console.log(`🏆 Prize logged: ${amount} to winner ${userId} (position ${position})`);
        
      } catch (error) {
        console.error(`❌ Prize payout failed for ${winner.userId}:`, error);
        results.push({
          userId: winner.userId,
          position: winner.position,
          amount: winner.amount,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Refund buy-ins when tournament is cancelled
   */
  async refundBuyIns(playerIds, buyInAmount, gameId) {
    const results = [];
    
    for (const playerId of playerIds) {
      try {
        const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
        
        if (!userResult.success || !userResult.data) {
          console.error(`❌ Player not found for refund: ${playerId}`);
          results.push({
            userId: playerId,
            refundAmount: buyInAmount,
            success: false,
            error: 'User not found'
          });
          continue;
        }
        
        const user = userResult.data;
        
        if (!user.walletAddress) {
          console.error(`❌ Player wallet address not found: ${playerId}`);
          results.push({
            userId: playerId,
            refundAmount: buyInAmount,
            success: false,
            error: 'Wallet address not found'
          });
          continue;
        }
        
        // Process blockchain refund from platform to player's pool
        console.log(`💰 [REFUND] Processing refund: ${buyInAmount} USDT to player ${playerId}`);
        
        const refundResult = await this.processRefundToPool(user.walletAddress, buyInAmount, gameId);
        
        if (refundResult.success) {
          // Log successful transaction
          await this.logTransaction({
            userId: playerId,
            type: 'BUY_IN_REFUND',
            amount: buyInAmount,
            gameId,
            description: `Buy-in refund for cancelled game ${gameId}`,
            walletAddress: user.walletAddress,
            blockchainTxHash: refundResult.txHash
          });
          
          results.push({
            userId: playerId,
            refundAmount: buyInAmount,
            success: true,
            walletAddress: user.walletAddress,
            transactionId: `refund_${gameId}_${playerId}_${Date.now()}`,
            blockchainTxHash: refundResult.txHash,
            blockchainPending: refundResult.pending || false
          });
          
          console.log(`✅ [REFUND] Refund successful: ${buyInAmount} USDT to ${playerId}`);
        } else {
          // Log failed transaction
          await this.logTransaction({
            userId: playerId,
            type: 'BUY_IN_REFUND_FAILED',
            amount: buyInAmount,
            gameId,
            description: `Failed buy-in refund for cancelled game ${gameId}: ${refundResult.error}`,
            walletAddress: user.walletAddress,
            blockchainTxHash: null
          });
          
          results.push({
            userId: playerId,
            refundAmount: buyInAmount,
            success: false,
            error: refundResult.error
          });
          
          console.error(`❌ [REFUND] Refund failed for ${playerId}: ${refundResult.error}`);
        }
        
      } catch (error) {
        console.error(`❌ Refund failed for ${playerId}:`, error);
        results.push({
          userId: playerId,
          refundAmount: buyInAmount,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Process refund from platform wallet to player's pool
   */
  async processRefundToPool(playerWalletAddress, amount, gameId) {
    try {
      const config = require('../config/config');
      
      // Use master poker table contract as platform wallet (same as setup fee destination)
      const platformWalletAddress = config.MASTER_POKER_TABLE_CONTRACT;
      
      console.log(`💸 [REFUND] Transferring ${amount} USDT from platform to player pool`);
      console.log(`💸 [REFUND] From: ${platformWalletAddress}`);
      console.log(`💸 [REFUND] To: ${playerWalletAddress}`);
      
      // Use existing blockchain service transfer function (reverse direction)
      // Note: This assumes the platform wallet can transfer back to player pools
      // You may need to implement a specific refund function in blockchain service
      const transferResult = await blockchainService.transferFromPoolToTable(
        platformWalletAddress, // From platform
        playerWalletAddress,   // To player pool
        amount
      );
      
      if (transferResult.success) {
        console.log(`✅ [REFUND] Transfer successful: ${transferResult.txHash}`);
        return {
          success: true,
          txHash: transferResult.txHash,
          amount: amount,
          pending: transferResult.pending || false
        };
      } else {
        console.error(`❌ [REFUND] Transfer failed: ${transferResult.error}`);
        return {
          success: false,
          error: transferResult.error
        };
      }
      
    } catch (error) {
      console.error(`❌ [REFUND] Transfer error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Charge buy-in from player
   */
  async chargeBuyIn(playerId, amount, gameId) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('Player not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('Player wallet address not found');
      }
      
      // Get current pool balance
      const currentBalance = await this.getPoolBalance(user.walletAddress);
      
      // Check sufficient balance
      if (parseFloat(currentBalance) < amount) {
        throw new Error(`Insufficient balance. Required: ${amount}, Available: ${currentBalance}`);
      }
      
      // TODO: Implement blockchain transfer for buy-in charge
      // This should transfer tokens from player's pool to table/platform wallet
      console.log(`💰 Buy-in should be charged via blockchain: ${amount} from player ${playerId}`);
      
      // Log transaction
      await this.logTransaction({
        userId: playerId,
        type: 'BUY_IN_CHARGE',
        amount: -amount,
        gameId,
        description: `Buy-in for game ${gameId}`,
        walletAddress: user.walletAddress,
        blockchainTxHash: null // Will be populated when blockchain integration is complete
      });
      
      console.log(`💰 Buy-in charge logged: ${amount} from player ${playerId}`);
      
      return {
        success: true,
        chargedAmount: amount,
        walletAddress: user.walletAddress,
        transactionId: `buyin_${gameId}_${playerId}_${Date.now()}`,
        blockchainPending: true
      };
      
    } catch (error) {
      console.error(`❌ Buy-in charge failed:`, error);
      throw error;
    }
  }
  
  /**
   * Get user balance from blockchain pool using existing service
   */
  async getUserBalance(userId) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('User not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('User wallet address not found');
      }
      
      // Use existing blockchain service to get balance
      const poolBalance = await this.getPoolBalance(user.walletAddress);
      
      return {
        userId,
        walletAddress: user.walletAddress,
        poolBalance: parseFloat(poolBalance),
        lastUpdated: new Date()
      };
    } catch (error) {
      console.error(`❌ Get balance failed:`, error);
      throw error;
    }
  }
  
  /**
   * Add funds to user balance (for testing/admin)
   */
  async addFunds(userId, amount, description = 'Admin credit') {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('User not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('User wallet address not found');
      }
      
      // TODO: Implement blockchain transfer for admin credit
      // This should transfer tokens from admin/platform wallet to user's pool
      console.log(`💰 Admin funds should be added via blockchain: ${amount} to user ${userId}`);
      
      await this.logTransaction({
        userId,
        type: 'ADMIN_CREDIT',
        amount: amount,
        description,
        walletAddress: user.walletAddress,
        blockchainTxHash: null // Will be populated when blockchain integration is complete
      });
      
      return {
        success: true,
        addedAmount: amount,
        walletAddress: user.walletAddress,
        blockchainPending: true
      };
      
    } catch (error) {
      console.error(`❌ Add funds failed:`, error);
      throw error;
    }
  }
  
  /**
   * Log financial transaction
   */
  async logTransaction(transactionData) {
    const {
      userId,
      type,
      amount,
      gameId,
      description,
      walletAddress,
      blockchainTxHash,
      metadata = {}
    } = transactionData;
    
    const transactionLogData = {
      userId,
      type,
      amount,
      gameId,
      description,
      walletAddress,
      blockchainTxHash,
      transactionId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      metadata,
      status: blockchainTxHash ? 'COMPLETED' : 'PENDING'
    };
    
    const logResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, transactionLogData , mongoHelper.MODELS.TRANSACTION_LEDGER);
    
    if (logResult.success) {
      console.log(`📝 Transaction logged: ${type} - ${amount} for user ${userId}`);
      return logResult.data;
    } else {
      console.error(`❌ Failed to log transaction: ${logResult.error}`);
      return null;
    }
  }
  
  /**
   * Validate sufficient balance for multiple operations
   */
  async validateSufficientBalance(userId, requiredAmount) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('User not found');
      }
      
      const user = userResult.data;
      
      if (!user.walletAddress) {
        throw new Error('User wallet address not found');
      }
      
      // Get balance from user's pool
      const currentBalance = await this.getPoolBalance(user.walletAddress);
      const balance = parseFloat(currentBalance);
      
      return {
        sufficient: balance >= requiredAmount,
        currentBalance: balance,
        requiredAmount,
        shortfall: Math.max(0, requiredAmount - balance),
        walletAddress: user.walletAddress
      };
    } catch (error) {
      console.error(`❌ Balance validation failed:`, error);
      throw error;
    }
  }
  
  /**
   * Batch process multiple wallet operations
   */
  async batchProcessTransactions(transactions) {
    const results = [];
    
    for (const transaction of transactions) {
      try {
        let result;
        
        switch (transaction.type) {
          case 'CHARGE_SETUP_FEE':
            result = await this.chargeSetupFee(transaction.userId, transaction.amount, transaction.gameId);
            break;
          case 'PAY_HOST_REWARD':
            result = await this.payHostReward(transaction.userId, transaction.amount, transaction.gameId);
            break;
          case 'PAY_AFFILIATE':
            result = await this.payAffiliateCommission(transaction.userId, transaction.amount, transaction.gameId, transaction.referredUserId);
            break;
          case 'CHARGE_BUY_IN':
            result = await this.chargeBuyIn(transaction.userId, transaction.amount, transaction.gameId);
            break;
          default:
            throw new Error(`Unknown transaction type: ${transaction.type}`);
        }
        
        results.push({ ...transaction, result, success: true });
        
      } catch (error) {
        results.push({ ...transaction, error: error.message, success: false });
      }
    }
    
    return results;
  }
}

module.exports = new WalletIntegrationService();