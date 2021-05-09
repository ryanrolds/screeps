import {Process, Runnable, RunnableResult, running, sleeping, terminate} from "./os.process";
import {Tracer} from './lib.tracing';
import Kingdom from "./org.kingdom";
import OrgRoom from "./org.room";
import * as MEMORY from "./constants.memory"
import * as TASKS from "./constants.tasks"
import * as TOPICS from "./constants.topics"
import * as CREEPS from "./constants.creeps"
import {createCreep} from "./helpers.creeps"
import {definitions} from './constants.creeps'

const PROCESS_TTL = 500;
const REQUEST_BOOSTS_TTL = 1;

export default class SpawnManager {
  orgRoom: OrgRoom;
  id: string;
  prevTime: number;
  ttl: number;
  spawnIds: Id<StructureSpawn>[];

  constructor(id: string, room: OrgRoom) {
    this.id = id;
    this.orgRoom = room;
    this.prevTime = Game.time;
    this.ttl = PROCESS_TTL;

    const roomObject: Room = this.orgRoom.getRoomObject()
    if (!roomObject) {
      throw new Error('cannot create a spawn manager when room does not exist');
    }

    this.spawnIds = roomObject.find<StructureSpawn>(FIND_MY_STRUCTURES, {
      filter: structure => structure.structureType === STRUCTURE_SPAWN,
    }).map(spawn => spawn.id);
  }

  run(kingdom: Kingdom, trace: Tracer): RunnableResult {
    trace = trace.asId(this.id);

    const ticks = Game.time - this.prevTime;
    this.prevTime = Game.time;

    this.ttl -= ticks;

    const roomObject: Room = this.orgRoom.getRoomObject()
    if (!roomObject) {
      return terminate();
    }

    trace.log('Spawn manager run', {});

    this.spawnIds.forEach((id) => {
      const spawn = Game.getObjectById(id);
      if (!spawn) {
        this.ttl = -1;
        return;
      }

      const isIdle = !spawn.spawning;
      const energy = spawn.room.energyAvailable;
      const energyCapacity = spawn.room.energyCapacityAvailable;
      const energyPercentage = energy / energyCapacity;

      if (!isIdle) {
        const creep = Game.creeps[spawn.spawning.name];
        const role = creep.memory[MEMORY.MEMORY_ROLE];
        const boosts = CREEPS.definitions[role].boosts;
        const priority = CREEPS.definitions[role].processPriority;

        if (boosts) {
          this.requestBoosts(spawn, boosts, priority);
        }

        spawn.room.visual.text(
          spawn.spawning.name + '🛠️',
          spawn.pos.x - 1,
          spawn.pos.y,
          {align: 'right', opacity: 0.8},
        );
      } else {
        const spawnTopicSize = (this.orgRoom as any).getTopicLength(TOPICS.TOPIC_SPAWN);
        const spawnTopicBackPressure = Math.floor(energyCapacity * (1 - (0.09 * spawnTopicSize)));
        let energyLimit = _.max([300, spawnTopicBackPressure]);

        let minEnergy = 300;
        const numCreeps = (this.orgRoom as any).getColony().numCreeps;
        if (energyCapacity > 800) {
          if (numCreeps > 50) {
            minEnergy = energyCapacity * 0.90;
          } else if (numCreeps > 30) {
            minEnergy = energyCapacity * 0.80;
          } else if (numCreeps > 20) {
            minEnergy = energyCapacity * 0.60;
          } else if (numCreeps > 10) {
            minEnergy = 500;
          }
        }

        minEnergy = _.max([300, minEnergy]);

        if (energy >= minEnergy) {
          let request = (this.orgRoom as any).getNextRequest(TOPICS.TOPIC_SPAWN);
          if (request) {
            // Allow request to override energy limit
            if (request.details.energyLimit) {
              energyLimit = request.details.energyLimit;
            }

            this.createCreep(spawn, request.details.role, request.details.memory, energy, energyLimit);
            return;
          }

          const peek = (this.orgRoom as any).getKingdom().peekNextRequest(TOPICS.TOPIC_SPAWN);
          if (peek) {
            const role = peek.details.role;
            const definition = definitions[role];
            const numColonies = (this.orgRoom as any).getKingdom().getColonies().length;
            if (definition.energyMinimum && energy < definition.energyMinimum && numColonies > 3) {
              return;
            }
          }

          // Check inter-colony requests if the colony has spawns
          request = (this.orgRoom as any).getKingdom().getTopics()
            .getMessageOfMyChoice(TOPICS.TOPIC_SPAWN, (messages) => {
              const selected = messages.filter((message) => {
                const assignedShard = message.details.memory[MEMORY.MEMORY_ASSIGN_SHARD] || null;
                if (assignedShard && assignedShard != Game.shard.name) {
                  let portals: any[] = (this.orgRoom as any).getKingdom().getScribe()
                    .getPortals(assignedShard).filter((portal) => {
                      const distance = Game.map.getRoomLinearDistance((this.orgRoom as any).id,
                        portal.pos.roomName);
                      return distance < 2;
                    });

                  if (!portals.length) {
                    return false;
                  }

                  return true;
                }

                const assignedRoom = message.details.memory[MEMORY.MEMORY_ASSIGN_ROOM];
                if (!assignedRoom) {
                  return false;
                }

                const distance = Game.map.getRoomLinearDistance((this.orgRoom as any).id,
                  assignedRoom);
                if (distance > 5) {
                  return false;
                }

                return true;
              });

              if (!selected.length) {
                return null;
              }

              return selected[0];
            });

          if (request) {
            this.createCreep(spawn, request.details.role, request.details.memory, energy, energyLimit);
            return;
          }
        }
      }
    })

    if (this.ttl < 0) {
      return terminate();
    }

    return running();
  }

  createCreep(spawner, role, memory, energy, energyLimit) {
    return createCreep((this.orgRoom as any).getColony().id, (this.orgRoom as any).id, spawner,
      role, memory, energy, energyLimit);
  }

  requestBoosts(spawn: StructureSpawn, boosts, priority: number) {
    (this.orgRoom as any).sendRequest(TOPICS.BOOST_PREP, priority, {
      [MEMORY.TASK_ID]: `bp-${spawn.id}-${Game.time}`,
      [MEMORY.PREPARE_BOOSTS]: boosts,
    }, REQUEST_BOOSTS_TTL);
  }
}
