// Spawn requests
const PRIORITY_MINER = 16;
const PRIORITY_DISTRIBUTOR = 15;
const PRIORITY_HAULER = 14;
const PRIORITY_DEFENDER = 13;
const PRIORITY_REMOTE_MINER = 12;
const PRIORITY_REMOTE_HAULER = 11;
const PRIORITY_ATTACKER = 10;
const PRIORITY_HARVESTER = 9;
const PRIORITY_REPAIRER_URGENT = 8.5;
const PRIORITY_UPGRADER = 8;
const PRIORITY_REMOTE_HARVESTER = 7;
const PRIORITY_REPAIRER = 6;
const PRIORITY_BUILDER = 5;
const PRIORITY_CLAIMER = 4;
const PRIORITY_RESERVER = 3;

// Prioritize setting up additional colonies
const PRIORITY_BOOTSTRAP = 0;

// Terminal
const TERMINAL_SELL = 1;
const TERMINAL_BUY = 2;


// Defense - TODO

module.exports = {
  PRIORITY_DISTRIBUTOR,
  PRIORITY_DEFENDER,
  PRIORITY_HARVESTER,
  PRIORITY_REMOTE_HARVESTER,
  PRIORITY_MINER,
  PRIORITY_REMOTE_MINER,
  PRIORITY_HAULER,
  PRIORITY_REMOTE_HAULER,
  PRIORITY_UPGRADER,
  PRIORITY_BUILDER,
  PRIORITY_REPAIRER,
  PRIORITY_REPAIRER_URGENT,
  PRIORITY_CLAIMER,
  PRIORITY_RESERVER,
  PRIORITY_ATTACKER,
  PRIORITY_BOOTSTRAP,
  TERMINAL_SELL,
  TERMINAL_BUY,
};
