const mongoHelper = require('../models/customdb');

class AccountWalletService {
  normalizeWalletAddress(walletAddress) {
    if (!walletAddress || typeof walletAddress !== 'string') {
      return null;
    }

    return walletAddress.trim().toLowerCase();
  }

  buildShortWalletAddress(walletAddress) {
    if (!walletAddress || walletAddress.length < 10) {
      return null;
    }

    return `${walletAddress.substring(0, 5)}....${walletAddress.substring(walletAddress.length - 10)}`;
  }

  getLinkedWallets(user = {}) {
    const normalizedLegacyWallet = this.normalizeWalletAddress(user.walletAddress);
    const linkedWallets = Array.isArray(user.linkedWallets) ? [...user.linkedWallets] : [];

    if (normalizedLegacyWallet && !linkedWallets.some(wallet => this.normalizeWalletAddress(wallet.address) === normalizedLegacyWallet)) {
      linkedWallets.unshift({
        address: normalizedLegacyWallet,
        shortAddress: user.shortWalletAddress || this.buildShortWalletAddress(normalizedLegacyWallet),
        platform: user.platform || null,
        linkedAt: user.createdAt || new Date().toISOString(),
        isPrimary: true,
        isActivePayout: true,
      });
    }

    return linkedWallets.map(wallet => ({
      ...wallet,
      address: this.normalizeWalletAddress(wallet.address),
      shortAddress: wallet.shortAddress || this.buildShortWalletAddress(wallet.address),
    }));
  }

  getActiveWalletAddress(user = {}) {
    const activePayoutWallet = this.normalizeWalletAddress(user.activePayoutWallet);
    const linkedWallets = this.getLinkedWallets(user);

    if (activePayoutWallet && linkedWallets.some(wallet => this.normalizeWalletAddress(wallet.address) === activePayoutWallet)) {
      return activePayoutWallet;
    }

    const activeWallet = linkedWallets.find(wallet => wallet.isActivePayout || wallet.isPrimary);
    return this.normalizeWalletAddress(activeWallet?.address || user.walletAddress);
  }

  hasWallet(user = {}, walletAddress) {
    const normalizedWalletAddress = this.normalizeWalletAddress(walletAddress);
    if (!normalizedWalletAddress) {
      return false;
    }

    return this.getLinkedWallets(user).some(
      wallet => this.normalizeWalletAddress(wallet.address) === normalizedWalletAddress
    );
  }

  buildLinkedWalletsForPersistence(user = {}, newWallet = {}) {
    const normalizedNewAddress = this.normalizeWalletAddress(newWallet.address);
    const existingWallets = this.getLinkedWallets(user)
      .filter(wallet => this.normalizeWalletAddress(wallet.address) !== normalizedNewAddress)
      .map(wallet => ({
        ...wallet,
        isActivePayout: false,
      }));

    return [
      {
        address: normalizedNewAddress,
        shortAddress: newWallet.shortAddress || this.buildShortWalletAddress(normalizedNewAddress),
        platform: newWallet.platform || null,
        linkedAt: newWallet.linkedAt || new Date().toISOString(),
        isPrimary: true,
        isActivePayout: true,
      },
      ...existingWallets,
    ];
  }

  async ensureWalletAvailable(userId, role = 'User') {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!userResult.success || !userResult.data) {
      throw new Error(`${role} not found`);
    }

    const user = userResult.data;
    const walletAddress = this.getActiveWalletAddress(user);
    if (!walletAddress) {
      throw new Error(`${role} does not have a linked wallet`);
    }

    return {
      ...user,
      walletAddress,
      shortWalletAddress: user.shortWalletAddress || this.buildShortWalletAddress(walletAddress),
      linkedWallets: this.getLinkedWallets(user),
      activePayoutWallet: walletAddress,
    };
  }

  async getWalletSummaryForUser(userId) {
    const user = await this.ensureWalletAvailable(userId, 'User');
    return this.buildWalletSummary(user);
  }

  async findUserByWalletAddress(walletAddress) {
    const normalizedWalletAddress = this.normalizeWalletAddress(walletAddress);
    if (!normalizedWalletAddress) {
      return null;
    }

    const directMatch = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, {
      walletAddress: normalizedWalletAddress,
    });

    if (directMatch.success && directMatch.data?.length) {
      return directMatch.data[0];
    }

    const linkedMatch = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, {
      'linkedWallets.address': normalizedWalletAddress,
    });

    if (linkedMatch.success && linkedMatch.data?.length) {
      return linkedMatch.data[0];
    }

    return null;
  }

  buildWalletSummary(user = {}) {
    const linkedWallets = this.getLinkedWallets(user);
    const activeWalletAddress = this.getActiveWalletAddress(user);

    return {
      authType: user.authType || (activeWalletAddress ? 'web3' : 'web2'),
      hasLinkedWallet: !!activeWalletAddress,
      activePayoutWallet: activeWalletAddress,
      linkedWallets: linkedWallets.map(wallet => ({
        address: wallet.address,
        shortAddress: wallet.shortAddress,
        platform: wallet.platform || null,
        linkedAt: wallet.linkedAt || null,
        isPrimary: !!wallet.isPrimary,
        isActivePayout: this.normalizeWalletAddress(wallet.address) === activeWalletAddress,
      })),
    };
  }

  async setActivePayoutWallet(userId, walletAddress) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!userResult.success || !userResult.data) {
      throw new Error('User not found');
    }

    const user = userResult.data;
    const normalizedWalletAddress = this.normalizeWalletAddress(walletAddress);
    if (!normalizedWalletAddress) {
      throw new Error('A valid wallet address is required');
    }

    const linkedWallets = this.getLinkedWallets(user);
    if (!linkedWallets.some(wallet => this.normalizeWalletAddress(wallet.address) === normalizedWalletAddress)) {
      throw new Error('Wallet is not linked to this account');
    }

    const nextLinkedWallets = linkedWallets.map(wallet => ({
      ...wallet,
      isPrimary: this.normalizeWalletAddress(wallet.address) === this.normalizeWalletAddress(user.walletAddress),
      isActivePayout: this.normalizeWalletAddress(wallet.address) === normalizedWalletAddress,
    }));

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      {
        activePayoutWallet: normalizedWalletAddress,
        linkedWallets: nextLinkedWallets,
      },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error || 'Failed to update active payout wallet');
    }

    return this.buildWalletSummary(updateResult.data || {
      ...user,
      activePayoutWallet: normalizedWalletAddress,
      linkedWallets: nextLinkedWallets,
    });
  }

  async unlinkWallet(userId, walletAddress) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!userResult.success || !userResult.data) {
      throw new Error('User not found');
    }

    const user = userResult.data;
    const normalizedWalletAddress = this.normalizeWalletAddress(walletAddress);
    if (!normalizedWalletAddress) {
      throw new Error('A valid wallet address is required');
    }

    const linkedWallets = this.getLinkedWallets(user);
    if (!linkedWallets.some(wallet => this.normalizeWalletAddress(wallet.address) === normalizedWalletAddress)) {
      throw new Error('Wallet is not linked to this account');
    }

    if (linkedWallets.length <= 1) {
      throw new Error('At least one wallet must remain linked to the account');
    }

    const remainingWallets = linkedWallets.filter(
      wallet => this.normalizeWalletAddress(wallet.address) !== normalizedWalletAddress
    );
    const nextActiveWalletAddress = this.normalizeWalletAddress(user.activePayoutWallet) === normalizedWalletAddress
      ? this.normalizeWalletAddress(remainingWallets[0]?.address)
      : this.getActiveWalletAddress({
          ...user,
          linkedWallets: remainingWallets,
        });

    const primaryWalletAddress = this.normalizeWalletAddress(user.walletAddress);
    let nextPrimaryWalletAddress = primaryWalletAddress;
    if (primaryWalletAddress === normalizedWalletAddress) {
      nextPrimaryWalletAddress = this.normalizeWalletAddress(remainingWallets[0]?.address);
    }

    const normalizedPrimaryCandidate = nextPrimaryWalletAddress
      || this.normalizeWalletAddress(remainingWallets[0]?.address)
      || null;

    const nextLinkedWallets = remainingWallets.map(wallet => ({
      ...wallet,
      isPrimary: this.normalizeWalletAddress(wallet.address) === normalizedPrimaryCandidate,
      isActivePayout: this.normalizeWalletAddress(wallet.address) === nextActiveWalletAddress,
    }));

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      {
        walletAddress: nextPrimaryWalletAddress,
        shortWalletAddress: this.buildShortWalletAddress(nextPrimaryWalletAddress),
        activePayoutWallet: nextActiveWalletAddress,
        linkedWallets: nextLinkedWallets,
      },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error || 'Failed to unlink wallet');
    }

    return this.buildWalletSummary(updateResult.data || {
      ...user,
      walletAddress: nextPrimaryWalletAddress,
      activePayoutWallet: nextActiveWalletAddress,
      linkedWallets: nextLinkedWallets,
    });
  }
}

module.exports = new AccountWalletService();
