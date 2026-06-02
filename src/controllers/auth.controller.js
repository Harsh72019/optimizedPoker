const { authService, userService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { ethers } = require('ethers');
const bcrypt = require('bcrypt');
const randomstring = require('randomstring');
const config = require('../config/config');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { abi: polygonTokenContractABI } = require('./MyToken.json');
const MasterPokerFactoryABI = require('../blockchain/masterpokertable.json').abi;
const mongoHelper = require('../models/customdb');
const accountWalletService = require('../services/account-wallet.service');
const custodialWalletService = require('../services/custodial-wallet.service');

const generateNonceMessage = walletAddress => `
  Welcome to Poker.
  Click to sign in.
  This request will not trigger a blockchain transaction or cost any gas fees.
  Your authentication status will reset after 24 hours.
  Wallet Address: ${walletAddress}.
  Nonce: ${randomstring.generate(12)}
`;

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;
const DEFAULT_WEB2_SIGNUP_BONUS = 5;

function buildAuthUserPayload(user, extra = {}) {
  return {
    token: signToken(user._id),
    username: user.username,
    email: user.email || null,
    profilePic: user.profilePic || null,
    dob: user.dob || null,
    accountType: user.accountType,
    handsFromNextTier: user.handsFromNextTier,
    reputation: user.reputation,
    tier: user.tier,
    recruits: user.recruits,
    authType: user.authType || 'web3',
    wallet: accountWalletService.buildWalletSummary(user),
    ...extra,
  };
}

function normalizeLoginSignature(signature) {
  const parsedSignature = ethers.Signature.from(signature);

  try {
    return parsedSignature.serialized;
  } catch (error) {
    const rawS = BigInt(parsedSignature._s);

    if (rawS <= SECP256K1_HALF_N) {
      throw error;
    }

    const canonicalS = ethers.toBeHex(SECP256K1_N - rawS, 32);
    const yParity = parsedSignature.yParity === 0 ? 1 : 0;

    return ethers.Signature.from({
      r: parsedSignature.r,
      s: canonicalS,
      yParity,
    }).serialized;
  }
}

const loginUser = catchAsync(async (req, res) => {
  try {
    const { walletAddress, signature, consent } = req.body;
    const normalizedWalletAddress = accountWalletService.normalizeWalletAddress(walletAddress);

    const user = await accountWalletService.findUserByWalletAddress(normalizedWalletAddress);
    if (!user) {
      return res.status(404).send({ status: false, error: 'User not found or wallet address wrong' });
    }

    if (user.isBlocked) {
      return res.status(403).send({ status: false, error: 'Your account has been blocked. Please contact admin' });
    }

    let normalizedSignature;
    try {
      normalizedSignature = normalizeLoginSignature(signature);
    } catch (sigError) {
      console.log('Signature normalization failed:', sigError.message);
      return res.status(401).send({ status: false, error: 'Invalid wallet signature' });
    }

    let signerAddr;
    try {
      signerAddr = ethers.verifyMessage(user.nonce_message, normalizedSignature);
    } catch (verifyError) {
      console.log('Signature verification failed:', verifyError.message);
      return res.status(401).send({ status: false, error: 'Invalid wallet signature' });
    }

    if (signerAddr.toLowerCase() !== normalizedWalletAddress.toLowerCase()) {
      const message = generateNonceMessage(normalizedWalletAddress);

      // Update user using mongoHelper
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        user._id,
        { nonce_message: message },
        mongoHelper.MODELS.USER
      );

      return res.status(401).send({ status: false, error: 'User not authenticated' });
    }

    const token = signToken(user._id);
    const message = generateNonceMessage(normalizedWalletAddress);

    // Update user with new nonce and consent
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      user._id,
      {
        nonce_message: message,
        consent: consent,
      },
      mongoHelper.MODELS.USER
    );

    const polygonProvider = new ethers.JsonRpcProvider(config.POLYGON_URL);
    let tokenContractAddress = config.USDT_TOKEN;
    const contract = new ethers.Contract(tokenContractAddress, polygonTokenContractABI, polygonProvider);
    const balance = (await contract.balanceOf(normalizedWalletAddress)).toString();

    return res.status(200).send({
      status: true,
      message: 'User token',
      data: {
        token,
        username: user.username,
        balance: ethers.formatUnits(balance, 6),
        profilePic : user.profilePic,
        dob : user.dob,
        username : user.username,
        accountType : user.accountType,
        handsFromNextTier : user.handsFromNextTier,
        reputation : user.reputation,
        tier : user.tier,
        recruits : user.recruits
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const userVerification = catchAsync(async (req, res) => {
  try {
    const { walletAddress, platform, referralCode } = req.body;
    const normalizedWalletAddress = accountWalletService.normalizeWalletAddress(walletAddress);

    const existingUser = await accountWalletService.findUserByWalletAddress(normalizedWalletAddress);
    const message = generateNonceMessage(normalizedWalletAddress);
    const shortWalletAddress = accountWalletService.buildShortWalletAddress(normalizedWalletAddress);
    const linkedWallets = normalizedWalletAddress
      ? [{
          address: normalizedWalletAddress,
          shortAddress: shortWalletAddress,
          platform: platform || null,
          linkedAt: new Date().toISOString(),
          isPrimary: true,
          isActivePayout: true,
        }]
      : [];

    if (existingUser) {
      // User exists, update nonce message
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        existingUser._id,
        { nonce_message: message },
        mongoHelper.MODELS.USER
      );
    } else {
      // User doesn't exist, create new user
      const userJson = {
        walletAddress: normalizedWalletAddress,
        nonce_message: message,
        username: await generateUniqueUsername(),
        referralCode: await generateUniqueReferralCode(),
        shortWalletAddress,
        platform,
        linkedWallets,
        activePayoutWallet: normalizedWalletAddress,
        authType: normalizedWalletAddress ? 'web3' : 'web2',
      };
      console.log('creating new user');
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.USERS, userJson, mongoHelper.MODELS.USER);

      // Handle referral if provided
      if (referralCode && createResult.success) {
        const recruitEarningsService = require('../services/recruitEarnings.service');
        await recruitEarningsService.addRecruit(createResult.data._id, referralCode);
      }
    }

    res.send({ status: true, message: 'Nonce message', data: message });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const adjectives = [
  'Sly',
  'Bold',
  'Jolly',
  'Calm',
  'Swift',
  'Brave',
  'Keen',
  'Witty',
  'Loyal',
  'Merry',
  'Wild',
  'Quick',
  'Shy',
  'Lucky',
  'Bright',
  'Quiet',
  'Proud',
  'Zesty',
  'Crafty',
  'Smooth',
  'Feisty',
  'Happy',
  'Noble',
  'Daring',
  'Gentle',
  'Curious',
  'Steady',
  'Vigilant',
  'Clever',
  'Cheerful',
  'Fierce',
  'Sassy',
  'Sturdy',
  'Dashing',
  'Plucky',
  'Spry',
  'Grumpy',
  'Dazzling',
  'Breezy',
  'Mighty',
  'Nimble',
  'Radiant',
  'Gallant',
  'Jumpy',
  'Wise',
  'Sunny',
  'Snappy',
  'Charming',
  'Gritty',
  'Hasty',
  'Lively',
  'Eager',
  'Sneaky',
  'Bouncy',
  'Perky',
  'Peppy',
  'Tidy',
  'Zany',
  'Thrifty',
  'Brisk',
  'Whizzy',
  'Wiry',
  'Dapper',
  'Zippy',
  'Lush',
  'Frisky',
  'Smiley',
  'Fearless',
  'Peppy',
  'Nifty',
  'Bubbly',
  'Grim',
  'Stout',
  'Whimsical',
  'Flashy',
  'Jazzy',
  'Giddy',
  'Bashful',
  'Savvy',
  'Crisp',
  'Lanky',
  'Scrappy',
  'Spunky',
  'Chirpy',
  'Buzzing',
  'Gracious',
  'Playful',
  'Zippy',
  'Punky',
  'Silly',
  'Coy',
  'Sprightly',
  'Brisk',
  'Rowdy',
  'Speedy',
  'Energetic',
  'Gleeful',
  'Gutsy',
  'Zappy',
  'Thrifty',
  'Shiny',
  'Hearty',
  'Snug',
  'Pithy',
];

const nouns = [
  'Dragon',
  'Phoenix',
  'Titan',
  'Valkyrie',
  'Wizard',
  'Elf',
  'Dwarf',
  'Goblin',
  'Cyclops',
  'Gryphon',
  'Unicorn',
  'Sphinx',
  'Troll',
  'Golem',
  'Pegasus',
  'Kraken',
  'Mermaid',
  'Basilisk',
  'Djinn',
  'Vampire',
  'Werewolf',
  'Nymph',
  'Centaur',
  'Chimera',
  'Hydra',
  'Minotaur',
  'Fairy',
  'Imp',
  'Witch',
  'Sorcerer',
  'Warlock',
  'Orc',
  'Zombie',
  'Ghoul',
  'Banshee',
  'Lich',
  'Ogre',
  'Wraith',
  'Demon',
  'Angel',
  'Alien',
  'Robot',
  'Cyborg',
  'Spaceship',
  'Asteroid',
  'Android',
  'TimeTraveler',
  'Starship',
  'Mech',
  'Mutant',
  'Sentinel',
  'Guardian',
  'Paladin',
  'Necromancer',
  'Ranger',
  'Knight',
  'Assassin',
  'Samurai',
  'Ninja',
  'Pirate',
  'Barbarian',
  'Gladiator',
  'Viking',
  'Rogue',
  'Monk',
  'Mage',
  'Alchemist',
  'Archer',
  'Bard',
  'Crusader',
  'Cleric',
  'Druid',
  'Enchanter',
  'Illusionist',
  'Jester',
  'Champion',
  'Warden',
  'Shapeshifter',
  'Berserker',
  'Behemoth',
  'Titan',
  'Archon',
  'Phantom',
  'Specter',
  'Shade',
  'Avatar',
  'Reaper',
  'Executioner',
  'Seer',
  'Oracle',
  'Prophet',
  'Mystic',
  'Thief',
  'Siren',
  'Harpy',
  'Elemental',
  'Beholder',
  'Spartan',
  'Templar',
  'Nomad',
  'Sorceress',
  'Warrior',
  'Commander',
  'Conqueror',
];

async function generateUniqueUsername() {
  let username;
  let isTaken = true;

  while (isTaken) {
    const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    username = `${randomAdjective.toLowerCase()}${randomNoun.toLowerCase()}`;

    if (username.length > 9) {
      username = username.slice(0, 9);
    } else if (username.length < 7) {
      username = `${randomAdjective.toLowerCase()}${randomNoun.toLowerCase()}`.slice(0, 9);
    }

    // Check if username exists using mongoHelper
    const userExistsResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USERS, 'username', username);

    isTaken = userExistsResult.success && userExistsResult.data;
  }

  return username;
}

async function generateUniqueReferralCode() {
  let referralCode;
  let isTaken = true;

  while (isTaken) {
    referralCode = randomstring.generate({ length: 8, charset: 'alphanumeric', capitalization: 'uppercase' });
    const result = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USERS, 'referralCode', referralCode);
    isTaken = result.success && result.data;
  }

  return referralCode;
}

const registration = catchAsync(async (req, res) => {
  try {
    const { walletAddress, signature, consent } = req.body;
    const normalizedWalletAddress = accountWalletService.normalizeWalletAddress(walletAddress);

    // Check if user already exists
    const existingUser = await accountWalletService.findUserByWalletAddress(normalizedWalletAddress);
    if (existingUser) {
      return res.status(404).send({ status: false, error: 'User already registered, kindly login' });
    }

    const message = generateNonceMessage(normalizedWalletAddress);
    const shortWalletAddress = accountWalletService.buildShortWalletAddress(normalizedWalletAddress);
    const userJson = {
      walletAddress: normalizedWalletAddress,
      nonce_message: message,
      username: uuidv4(),
      shortWalletAddress,
      linkedWallets: normalizedWalletAddress
        ? [{
            address: normalizedWalletAddress,
            shortAddress: shortWalletAddress,
            platform: null,
            linkedAt: new Date().toISOString(),
            isPrimary: true,
            isActivePayout: true,
          }]
        : [],
      activePayoutWallet: normalizedWalletAddress,
      authType: normalizedWalletAddress ? 'web3' : 'web2',
    };

    // Create new user using mongoHelper
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.USERS, userJson, mongoHelper.MODELS.USER);

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    const newUser = createResult.data;
    const token = signToken(newUser._id);

    res.send({ status: true, message: 'Nonce message', data: { message, token } });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const web2Register = catchAsync(async (req, res) => {
  const { email, password, username, referralCode, consent } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const existingUserResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, { email: normalizedEmail });
  if (existingUserResult.success && existingUserResult.data?.length) {
    return res.status(409).send({ status: false, error: 'User already registered, kindly login' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userJson = {
    email: normalizedEmail,
    password: passwordHash,
    username: username || await generateUniqueUsername(),
    referralCode: await generateUniqueReferralCode(),
    consent: !!consent,
    authType: 'web2',
    linkedWallets: [],
    activePayoutWallet: null,
  };

  const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.USERS, userJson, mongoHelper.MODELS.USER);
  if (!createResult.success || !createResult.data) {
    throw new Error(createResult.error || 'Failed to create web2 user');
  }

  if (referralCode) {
    const recruitEarningsService = require('../services/recruitEarnings.service');
    await recruitEarningsService.addRecruit(createResult.data._id, referralCode);
  }

  const rewardedUser = await custodialWalletService.grantSignupBonus(createResult.data._id, DEFAULT_WEB2_SIGNUP_BONUS);
  const rewards = await require('../services/promo-reward.service').getRewardStatus(rewardedUser._id);

  res.status(201).send({
    status: true,
    message: 'Web2 account created successfully',
    data: buildAuthUserPayload(rewardedUser, {
      balance: {
        custodial: Number(rewardedUser.cashBalance || 0),
        rewards,
      },
    }),
  });
});

const web2Login = catchAsync(async (req, res) => {
  const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
  const userResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, { email: normalizedEmail });
  const user = userResult.success && userResult.data?.length ? userResult.data[0] : null;

  if (!user || !user.password) {
    return res.status(401).send({ status: false, error: 'Invalid email or password' });
  }

  if (user.isBlocked) {
    return res.status(403).send({ status: false, error: 'Your account has been blocked. Please contact admin' });
  }

  const isPasswordMatch = await bcrypt.compare(req.body.password, user.password);
  if (!isPasswordMatch) {
    return res.status(401).send({ status: false, error: 'Invalid email or password' });
  }

  const rewards = await require('../services/promo-reward.service').getRewardStatus(user._id);
  res.status(200).send({
    status: true,
    message: 'User token',
    data: buildAuthUserPayload(user, {
      balance: {
        custodial: Number(user.cashBalance || 0),
        rewards,
      },
    }),
  });
});

const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: false,
        error: 'You are not logged in! Please log in to get access.',
      });
    }

    const decoded = await promisify(jwt.verify)(token, config.JWT_SECRET);

    // Find current user using mongoHelper
    const currentUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, decoded.id);
    console.log(currentUserResult, "currentUserResult");
    if (!currentUserResult.success || !currentUserResult.data) {
      return res.status(401).json({
        status: false,
        msg: 'The user belonging to this token does no longer exist.',
      });
    }

    const currentUser = currentUserResult.data;

    // Check if user is blocked
    if (currentUser.isBlocked) {
      return res.status(403).json({
        status: false,
        error: 'Your account has been blocked. Please contact support.',
      });
    }

    req.user = currentUser;
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({
      status: false,
      error: err.message,
    });
  }
};

const checkEmailExistence = async (req, res, next) => {
  try {
    // User will be available from the protect middleware
    const user = req.user;

    // Check if email exists
    if (!user.email) {
      return res.status(429).json({
        status: false,
        error: 'Email is required. Please update your profile before proceeding.',
      });
    }

    next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: false,
      error: 'Error checking email existence',
    });
  }
};

const requestWalletLinkNonce = catchAsync(async (req, res) => {
  const { walletAddress, platform } = req.body;
  const normalizedWalletAddress = accountWalletService.normalizeWalletAddress(walletAddress);
  const existingUser = await accountWalletService.findUserByWalletAddress(normalizedWalletAddress);

  if (existingUser && existingUser._id !== req.user._id) {
    return res.status(409).send({ status: false, error: 'Wallet is already linked to another account' });
  }

  const nonceMessage = generateNonceMessage(normalizedWalletAddress);
  const pendingWalletLink = {
    walletAddress: normalizedWalletAddress,
    shortWalletAddress: accountWalletService.buildShortWalletAddress(normalizedWalletAddress),
    nonceMessage,
    requestedAt: new Date(),
    platform: platform || null,
  };

  await mongoHelper.updateById(
    mongoHelper.COLLECTIONS.USERS,
    req.user._id,
    { pendingWalletLink },
    mongoHelper.MODELS.USER
  );

  res.status(200).send({
    status: true,
    message: 'Wallet link nonce generated successfully',
    data: {
      walletAddress: normalizedWalletAddress,
      nonceMessage,
    },
  });
});

const confirmWalletLink = catchAsync(async (req, res) => {
  const { walletAddress, signature } = req.body;
  const normalizedWalletAddress = accountWalletService.normalizeWalletAddress(walletAddress);
  const currentUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, req.user._id);
  const currentUser = currentUserResult.success ? currentUserResult.data : null;

  if (!currentUser) {
    return res.status(404).send({ status: false, error: 'User not found' });
  }

  const pendingWalletLink = currentUser.pendingWalletLink || {};
  if (accountWalletService.normalizeWalletAddress(pendingWalletLink.walletAddress) !== normalizedWalletAddress || !pendingWalletLink.nonceMessage) {
    return res.status(400).send({ status: false, error: 'No pending wallet link request found for this wallet' });
  }

  let normalizedSignature;
  try {
    normalizedSignature = normalizeLoginSignature(signature);
  } catch (sigError) {
    return res.status(401).send({ status: false, error: 'Invalid wallet signature' });
  }

  let signerAddr;
  try {
    signerAddr = ethers.verifyMessage(pendingWalletLink.nonceMessage, normalizedSignature);
  } catch (verifyError) {
    return res.status(401).send({ status: false, error: 'Invalid wallet signature' });
  }

  if (signerAddr.toLowerCase() !== normalizedWalletAddress.toLowerCase()) {
    return res.status(401).send({ status: false, error: 'Wallet ownership verification failed' });
  }

  const existingUser = await accountWalletService.findUserByWalletAddress(normalizedWalletAddress);
  if (existingUser && existingUser._id !== req.user._id) {
    return res.status(409).send({ status: false, error: 'Wallet is already linked to another account' });
  }

  const linkedWallets = accountWalletService.buildLinkedWalletsForPersistence(currentUser, {
    address: normalizedWalletAddress,
    shortAddress: pendingWalletLink.shortWalletAddress,
    platform: pendingWalletLink.platform,
  });

  const authType = currentUser.authType === 'web2' ? 'hybrid' : (currentUser.authType || 'hybrid');
  const updateResult = await mongoHelper.updateById(
    mongoHelper.COLLECTIONS.USERS,
    req.user._id,
    {
      walletAddress: currentUser.walletAddress || normalizedWalletAddress,
      shortWalletAddress: currentUser.shortWalletAddress || pendingWalletLink.shortWalletAddress,
      activePayoutWallet: normalizedWalletAddress,
      linkedWallets,
      pendingWalletLink: null,
      authType,
    },
    mongoHelper.MODELS.USER
  );

  const updatedUser = updateResult.success ? updateResult.data : {
    ...currentUser,
    walletAddress: currentUser.walletAddress || normalizedWalletAddress,
    activePayoutWallet: normalizedWalletAddress,
    linkedWallets,
    authType,
  };

  res.status(200).send({
    status: true,
    message: 'Wallet linked successfully',
    data: {
      wallet: accountWalletService.buildWalletSummary(updatedUser),
    },
  });
});
const signToken = id => {
  return jwt.sign({ id }, config.JWT_SECRET);
};
module.exports = {
  loginUser,
  userVerification,
  protect,
  registration,
  web2Register,
  web2Login,
  checkEmailExistence,
  requestWalletLinkNonce,
  confirmWalletLink,
};
