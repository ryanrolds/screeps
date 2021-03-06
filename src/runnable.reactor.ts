import {Process, Runnable, RunnableResult, running, sleeping, terminate} from "./os.process";
import {thread} from './os.thread';
import {Tracer} from './lib.tracing';
import {Kingdom} from "./org.kingdom";
import OrgRoom from "./org.room";
import * as MEMORY from "./constants.memory"
import * as TASKS from "./constants.tasks"
import * as TOPICS from "./constants.topics"
import * as CREEPS from "./constants.creeps"
import * as PRIORITIES from "./constants.priorities"

const TASK_PHASE_LOAD = 'phase_transfer_resources';
const TASK_PHASE_REACT = 'phase_react';
const TASK_PHASE_UNLOAD = 'phase_unload';
const TASK_TTL = 25;

const REQUEST_LOAD_TTL = 20;
const REQUEST_UNLOAD_TTL = 20;
const REACTION_TTL = 0;
const NO_SLEEP = 0;
const NEW_TASK_SLEEP = 10;
const PRODUCE_STATUS_TTL = 25;

export const REACTION_UPDATE_TOPIC = 'reaction_updates';

export type ReactionUpdateMessage = {
  id: Id<StructureLab>;
  compound: MineralConstant | MineralCompoundConstant;
  amount: number;
}

export default class ReactorRunnable {
  id: string;
  orgRoom: OrgRoom;
  labIds: Id<StructureLab>[];
  prevTime: number;
  threadProduceStatus: any;

  constructor(id: string, orgRoom: OrgRoom, labIds: Id<StructureLab>[]) {
    this.id = id;
    this.orgRoom = orgRoom;
    this.labIds = labIds;
    this.prevTime = Game.time;

    this.threadProduceStatus = thread(PRODUCE_STATUS_TTL, null, null)(this.produceStatus.bind(this));
  }

  run(kingdom: Kingdom, trace: Tracer): RunnableResult {
    trace = trace.asId(this.id);

    const ticks = Game.time - this.prevTime;
    this.prevTime = Game.time;

    const room = this.orgRoom.getRoomObject();
    if (!room) {
      trace.log("room not found - terminating", {});
      return terminate();
    }

    let labs = this.labIds.map(labId => Game.getObjectById(labId));
    if (_.filter(labs, lab => !lab).length) {
      trace.log('lab missing - terminating', {labIds: this.labIds})
      return terminate();
    }

    let task = room.memory[this.getTaskMemoryId()] || null;
    if (!task) {
      trace.log('no current task', {})

      const task = (this.orgRoom as any).getKingdom().getNextRequest(TOPICS.TASK_REACTION);
      if (!task) {
        trace.log('no available tasks', {})
        return sleeping(NEW_TASK_SLEEP);
      }

      task[MEMORY.REACTOR_TTL] = TASK_TTL;
      room.memory[this.getTaskMemoryId()] = task;

      trace.log('got new task', {task})
    }

    if (task) {
      this.threadProduceStatus(task.details[MEMORY.REACTOR_OUTPUT],
        labs[0]?.store.getUsedCapacity(task.details[MEMORY.REACTOR_OUTPUT]), trace);
    }

    trace.log('reactor run', {
      labIds: this.labIds,
      ticks,
      task,
    });

    if (task) {
      const sleepFor = this.processTask(room, labs, task, ticks, trace)
      if (sleepFor) {
        return sleeping(sleepFor);
      }
    }

    return running();
  }

  getOutput() {
    if (this.isIdle()) {
      return null;
    }

    return this.getTask().details[MEMORY.REACTOR_OUTPUT];
  }
  getTaskMemoryId() {
    return `${MEMORY.REACTOR_TASK}_${this.labIds[0]}`;
  }
  getTask() {
    const room = this.orgRoom.getRoomObject();
    if (!room) {
      return null;
    }

    return room.memory[this.getTaskMemoryId()] || null;
  }
  isIdle() {
    return !this.getTask();
  }
  clearTask() {
    const room = this.orgRoom.getRoomObject();
    if (!room) {
      return;
    }

    delete room.memory[this.getTaskMemoryId()];
  }

  // TODO create type for task
  processTask(room: Room, labs: StructureLab[], task: any, ticks: number, trace: Tracer): number {
    const inputA = task.details[MEMORY.REACTOR_INPUT_A];
    const amount = task.details[MEMORY.REACTOR_AMOUNT];
    const inputB = task.details[MEMORY.REACTOR_INPUT_B];
    const phase = task[MEMORY.TASK_PHASE] || TASK_PHASE_LOAD;

    switch (phase) {
      case TASK_PHASE_LOAD:
        // Maintain task TTL. We want to abort hard to perform tasks
        let ttl = task[MEMORY.REACTOR_TTL];
        // Check if we have lowered the TTL and use the new one
        if (ttl > TASK_TTL) {
          ttl = TASK_TTL;
        }

        if (ttl <= 0) {
          trace.log('ttl exceeded, clearing task', {});
          this.clearTask();
          return NO_SLEEP;
        } else {
          room.memory[this.getTaskMemoryId()][MEMORY.TASK_PHASE] = TASK_PHASE_LOAD;
          room.memory[this.getTaskMemoryId()][MEMORY.REACTOR_TTL] = ttl - ticks;
        }

        const readyA = this.prepareInput(labs[1], inputA, amount, trace);
        const readyB = this.prepareInput(labs[2], inputB, amount, trace);

        if (readyA && readyB) {
          trace.log('loaded, moving to react phase', {});
          room.memory[this.getTaskMemoryId()][MEMORY.TASK_PHASE] = TASK_PHASE_REACT;
          return NO_SLEEP;
        }

        return REQUEST_LOAD_TTL;
      case TASK_PHASE_REACT:
        if (labs[0].cooldown) {
          trace.log('reacting cooldown', {cooldown: labs[0].cooldown});
          return labs[0].cooldown;
        }

        const result = labs[0].runReaction(labs[1], labs[2]);
        if (result !== OK) {
          trace.log('reacted, moving to unload phase', {});
          room.memory[this.getTaskMemoryId()][MEMORY.TASK_PHASE] = TASK_PHASE_UNLOAD;
          return NO_SLEEP;
        }

        return REACTION_TTL;
      case TASK_PHASE_UNLOAD:
        const lab = labs[0];
        if (!lab.mineralType || lab.store.getUsedCapacity(lab.mineralType) === 0) {
          trace.log('unloaded, task complete', {});
          this.clearTask();
          return NO_SLEEP;
        }

        this.unloadLab(labs[0], trace);

        return REQUEST_UNLOAD_TTL;
      default:
        trace.error('BROKEN REACTION LOGIC', phase);
        this.clearTask();
        return NO_SLEEP;
    }
  }

  unloadLabs(labs: StructureLab[], trace: Tracer) {
    labs.forEach((lab) => {
      if (lab.mineralType) {
        this.unloadLab(lab, trace);
      }
    });
  }

  prepareInput(lab: StructureLab, resource, desiredAmount: number, trace: Tracer) {
    let currentAmount = 0;
    if (lab.mineralType) {
      currentAmount = lab.store.getUsedCapacity(lab.mineralType);
    }

    // Unload the lab if it's not the right mineral
    if (lab.mineralType && lab.mineralType !== resource && lab.store.getUsedCapacity(lab.mineralType) > 0) {
      this.unloadLab(lab, trace);
      return false;
    }

    // Load the lab with the right mineral
    if (currentAmount < desiredAmount) {
      const pickup = this.orgRoom.getReserveStructureWithMostOfAResource(resource, true);
      const missingAmount = desiredAmount - currentAmount;

      if (!pickup) {
        this.requestResource(resource, missingAmount, trace);
      } else {
        this.loadLab(lab, pickup, resource, missingAmount, trace);
      }

      return false;
    }

    return true;
  }

  requestResource(resource: ResourceConstant, amount: number, trace: Tracer) {
    // TODO this really should use topics/IPC
    trace.log('requesting resource from governor', {resource, amount});

    const resourceGovernor = (this.orgRoom as any).getKingdom().getResourceGovernor();
    const requested = resourceGovernor.requestResource(this.orgRoom, resource, amount, REQUEST_LOAD_TTL, trace);
    if (!requested) {
      resourceGovernor.buyResource(this.orgRoom, resource, amount, REQUEST_LOAD_TTL, trace);
    }
  }

  loadLab(lab: StructureLab, pickup: AnyStoreStructure, resource: ResourceConstant, amount: number, trace: Tracer) {
    trace.log('requesting load', {
      lab: lab.id,
      resource: resource,
      amount: amount,
      pickup: pickup.id,
      ttl: REQUEST_LOAD_TTL,
    });

    (this.orgRoom as any).getColony().sendRequest(TOPICS.HAUL_CORE_TASK, PRIORITIES.HAUL_REACTION, {
      [MEMORY.TASK_ID]: `load-${this.id}-${Game.time}`,
      [MEMORY.MEMORY_TASK_TYPE]: TASKS.HAUL_TASK,
      [MEMORY.MEMORY_HAUL_PICKUP]: pickup.id,
      [MEMORY.MEMORY_HAUL_RESOURCE]: resource,
      [MEMORY.MEMORY_HAUL_AMOUNT]: amount,
      [MEMORY.MEMORY_HAUL_DROPOFF]: lab.id,
    }, REQUEST_LOAD_TTL);
  }

  unloadLab(lab, trace: Tracer) {
    const currentAmount = lab.store.getUsedCapacity(lab.mineralType);
    const dropoff = this.orgRoom.getReserveStructureWithRoomForResource(lab.mineralType);

    trace.log('requesting unload', {
      lab: lab.id,
      resource: lab.mineralType,
      amount: currentAmount,
      dropoff: dropoff.id,
      ttl: REQUEST_LOAD_TTL,
    });

    this.orgRoom.getColony().sendRequest(TOPICS.HAUL_CORE_TASK, PRIORITIES.HAUL_REACTION, {
      [MEMORY.TASK_ID]: `unload-${this.id}-${Game.time}`,
      [MEMORY.MEMORY_TASK_TYPE]: TASKS.HAUL_TASK,
      [MEMORY.MEMORY_HAUL_PICKUP]: lab.id,
      [MEMORY.MEMORY_HAUL_RESOURCE]: lab.mineralType,
      [MEMORY.MEMORY_HAUL_AMOUNT]: currentAmount,
      [MEMORY.MEMORY_HAUL_DROPOFF]: dropoff.id,
    }, REQUEST_LOAD_TTL);
  }

  produceStatus(resource: ResourceConstant, amount: number, trace: Tracer) {
    const status = {
      [MEMORY.REACTION_STATUS_ROOM]: this.orgRoom.id,
      [MEMORY.REACTION_STATUS_RESOURCE]: resource,
      [MEMORY.REACTION_STATUS_RESOURCE_AMOUNT]: amount,
    };

    trace.log('producing reactor status', {status});

    this.orgRoom.getKingdom().sendRequest(TOPICS.ACTIVE_REACTIONS, 1, status, PRODUCE_STATUS_TTL);
  }
}
