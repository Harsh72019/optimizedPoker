// src/engine/pot-calculator.js

class PotCalculator {
  static calculateSidePots(players, totalContributions) {

    const active = players.filter(
      p => p.status !== 'FOLDED'
    );

    if (active.length === 0) return [];

    const contributions = active
      .map(p => ({
        id: p.id,
        contribution: totalContributions[p.id] || 0
      }))
      .sort((a, b) => a.contribution - b.contribution);

    const maxContribution = Math.max(...contributions.map(c => c.contribution));
    
    if (maxContribution === 0) return [];

    const pots = [];
    let previous = 0;

    for (let i = 0; i < contributions.length; i++) {
      const current = contributions[i];
      const diff = current.contribution - previous;

      if (diff <= 0) continue;

      const eligible = contributions
        .filter(p => p.contribution >= current.contribution)
        .map(p => p.id);

      const potAmount = diff * eligible.length;

      pots.push({
        amount: potAmount,
        eligible
      });

      previous = current.contribution;
    }

    return pots;
  }

  static distribute(pots, winners) {

  const distributions = [];

  pots.forEach(pot => {

    const eligibleWinners = winners
      .filter(w => pot.eligible.includes(w.playerId));

    if (eligibleWinners.length === 0) return;

    const share = pot.amount / eligibleWinners.length;

    eligibleWinners.forEach(w => {
      const existing = distributions.find(d => d.playerId === w.playerId);
      if (existing) {
        existing.amount += share;
      } else {
        distributions.push({
          playerId: w.playerId,
          amount: share
        });
      }
    });
  });

  return distributions;
}
}

module.exports = PotCalculator;