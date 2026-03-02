const MATCHMAKING_TIERS = [
    {
        name: 'Human Tier',
        minAccountType: 'Human',
        commission: 5.0,
        tournamentEntrance: 11.0,
        organizerProfitPT: 0,
        bankAllocatedReserve: 5000,
        subTiers: [
            { name: '0.01/0.02', bb: 0.02 },
            { name: '0.02/0.04', bb: 0.04 },
            { name: '0.04/0.08', bb: 0.08 },
            { name: '0.08/0.16', bb: 0.16 }
        ]
    },
    {
        name: 'Rat Tier',
        minAccountType: 'Rat',
        commission: 3.5,
        tournamentEntrance: 7.0,
        organizerProfitPT: 7,
        bankAllocatedReserve: 15000,
        subTiers: [
            { name: '0.08/0.16', bb: 0.16 },
            { name: '0.16/0.32', bb: 0.32 },
            { name: '0.24/0.48', bb: 0.48 },
            { name: '0.32/0.64', bb: 0.64 }
        ]
    },
    {
        name: 'Cat Tier',
        minAccountType: 'Cat',
        commission: 2.5,
        tournamentEntrance: 6.0,
        organizerProfitPT: 8,
        bankAllocatedReserve: 10000,
        subTiers: [
            { name: '0.24/0.48', bb: 0.48 },
            { name: '0.32/0.64', bb: 0.64 },
            { name: '0.48/0.72', bb: 0.72 },
            { name: '0.50/0.80', bb: 0.80 }
        ]
    },
    {
        name: 'Dog Tier',
        minAccountType: 'Dog',
        commission: 2.0,
        tournamentEntrance: 5.0,
        organizerProfitPT: 10,
        bankAllocatedReserve: 25000,
        subTiers: [
            { name: '0.48/0.72', bb: 0.72 },
            { name: '0.50/0.80', bb: 0.80 },
            { name: '0.60/0.90', bb: 0.90 },
            { name: '0.70/1.00', bb: 1.00 }
        ]
    }
];

module.exports = {
    MATCHMAKING_TIERS
};