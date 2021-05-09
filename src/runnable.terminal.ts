import {Process, Runnable, RunnableResult, running, sleeping, terminate} from "./os.process";
import {Tracer} from './lib.tracing';
import Kingdom from "./org.kingdom";
import OrgRoom from "./org.room";
import * as MEMORY from "./constants.memory"
import * as TASKS from "./constants.tasks"
import * as TOPICS from "./constants.topics"
import * as MARKET from "./constants.market"

const TASK_PHASE_HAUL_RESOURCE = 'phase_transfer_resource';
const TASK_PHASE_TRANSACT = 'phase_transact';
const TASK_PHASE_TRANSFER = 'phase_transfer';
const TASK_TTL = 100;

const MAX_TERMINAL_ENERGY = 1000;

const PROCESS_TASK_TTL = 10;
const REQUEST_RETURN_ENERGY_TTL = 10;
const ORDER_MGMT_TTL = 55;


export default class TerminalRunnable {
  orgRoom: OrgRoom;
  terminalId: Id<StructureTerminal>;
  prevTime: number;
  processTaskTTL: number;
  returnEnergyTTL: number;
  updateOrdersTTL: number;

  constructor(room: OrgRoom, terminal: StructureTerminal) {
    this.orgRoom = room;

    this.terminalId = terminal.id;
    this.prevTime = Game.time;
    this.processTaskTTL = 0;
    this.returnEnergyTTL = REQUEST_RETURN_ENERGY_TTL;
    this.updateOrdersTTL = ORDER_MGMT_TTL;
  }

  run(kingdom: Kingdom, trace: Tracer): RunnableResult {
    trace = trace.asId(this.terminalId);

    const ticks = Game.time - this.prevTime;
    this.prevTime = Game.time;

    this.processTaskTTL -= ticks;
    this.updateOrdersTTL -= ticks;
    this.returnEnergyTTL -= ticks;

    const terminal = Game.getObjectById(this.terminalId);
    // If terminal no longer exists, terminate
    if (!terminal) {
      trace.log('terminal not found - terminating', {})
      return terminate();
    }

    let task = terminal.room.memory[MEMORY.TERMINAL_TASK] || null;
    if (!task) {
      this.processTaskTTL = -1;
      task = (this.orgRoom as any).getNextRequest(TOPICS.TOPIC_TERMINAL_TASK);
      if (task) {
        terminal.room.memory[MEMORY.TERMINAL_TASK] = task;
      }
    }

    trace.log('terminal run', {
      ticks,
      processTaskTTL: this.processTaskTTL,
      returnEnergyTTL: this.returnEnergyTTL,
      updateOrdersTTL: this.updateOrdersTTL,
      task,
    })

    if (task && this.processTaskTTL < 0) {
      this.processTaskTTL = PROCESS_TASK_TTL;
      this.processTask(terminal, task, ticks, trace);
    } else if (!task) {
      const terminalAmount = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
      if (terminalAmount > MAX_TERMINAL_ENERGY && this.returnEnergyTTL < 0) {
        this.returnEnergyTTL = REQUEST_RETURN_ENERGY_TTL;

        const amountToTransfer = terminalAmount - MAX_TERMINAL_ENERGY;
        trace.log('send energy to storage', {amountToTransfer})
        this.sendEnergyToStorage(terminal, amountToTransfer, REQUEST_RETURN_ENERGY_TTL, trace);
      }
    }

    if (this.updateOrdersTTL < 0) {
      this.updateOrdersTTL = ORDER_MGMT_TTL;
      this.updateOrders(terminal, trace);
    }

    return running();
  }

  isIdle() {
    return !!this.orgRoom.getRoomObject()?.memory[MEMORY.TERMINAL_TASK];
  }
  getTask() {
    return this.orgRoom.getRoomObject()?.memory[MEMORY.TERMINAL_TASK] || null;
  }
  clearTask(trace) {
    trace.log('clearing task');
    delete this.orgRoom.getRoomObject()?.memory[MEMORY.TERMINAL_TASK];
  }

  processTask(terminal: StructureTerminal, task, ticks: number, trace: Tracer) {
    const details = task.details;
    const taskType = details[MEMORY.TERMINAL_TASK_TYPE];

    // Maintain task TTL. We want to abort hard to perform tasks
    let ttl = details[MEMORY.TASK_TTL];
    if (ttl === undefined) {
      ttl = TASK_TTL;
    }

    if (ttl < 0) {
      this.clearTask(trace);
      return;
    } else {
      terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TASK_TTL] = ttl - ticks;
    }

    trace.log('processTask', {task})

    switch (taskType) {
      case TASKS.TASK_TRANSFER:
        this.transferResource(terminal, details, trace);
        break;
      case TASKS.TASK_MARKET_ORDER:
        // Perform market order
        const orderType = details[MEMORY.MEMORY_ORDER_TYPE];
        if (orderType === ORDER_SELL) {
          this.sell(terminal, details, trace);
        } else if (orderType === ORDER_BUY) {
          this.buy(terminal, details, trace);
        } else {
          this.clearTask(trace);
        }

        break;
      default:
        this.clearTask(trace);
    }
    return;
  }

  transferResource(terminal: StructureTerminal, task, trace: Tracer) {
    const resource = task[MEMORY.TRANSFER_RESOURCE];
    let amount = task[MEMORY.TRANSFER_AMOUNT];
    const roomId = task[MEMORY.TRANSFER_ROOM];
    const phase = task[MEMORY.TASK_PHASE] || TASK_PHASE_HAUL_RESOURCE;

    trace.log('transfer resource', {resource, amount, roomId, phase});

    switch (phase) {
      case TASK_PHASE_HAUL_RESOURCE:
        // Check if we should move to next phase
        const terminalAmount = terminal.store.getUsedCapacity(resource);
        if (terminalAmount >= amount) {
          trace.log('terminal amount gte desired amount', {terminalAmount, amount});
          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TASK_PHASE] = TASK_PHASE_TRANSFER;
          break;
        }

        const pickup = this.orgRoom.getReserveStructureWithMostOfAResource(resource, false);
        if (!pickup) {
          if (!terminalAmount) {
            trace.log('no pickup and no resources in terminal', {});

            this.clearTask(trace);
            break;
          }

          trace.log('no pickup, but resources in terminal', {terminalAmount});

          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TASK_PHASE] = TASK_PHASE_TRANSFER;
          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TRANSFER_AMOUNT] = terminalAmount;
          break;
        }

        trace.log('requesting resource transfer to terminal', {pickup: pickup.id, resource, amount});

        this.haulResourceToTerminal(terminal, pickup, resource, amount);
        break;
      case TASK_PHASE_TRANSFER:
        let haulAmount = amount;

        const energyRequired = Game.market.calcTransactionCost(amount, terminal.room.name, roomId);
        // If we are transfering energy we need energy in addition to what we want to transfer
        if (resource === RESOURCE_ENERGY) {
          haulAmount += energyRequired;
          trace.log('padded energy', {amount, added: energyRequired});
        }

        const energyReady = this.haulTransferEnergyToTerminal(terminal, resource, haulAmount, roomId, trace);
        if (!energyReady) {
          trace.log('energy not ready', {amount, roomId});
          break;
        }

        const result = terminal.send(resource, amount, roomId);
        trace.log('sending result', {resource, amount, roomId, result});
        if (result !== OK) {

        }

        this.clearTask(trace);

        break;
      default:

        this.clearTask(trace);
    }
  }

  buy(terminal: StructureTerminal, task, trace: Tracer) {
    const resource = task[MEMORY.MEMORY_ORDER_RESOURCE] as ResourceConstant;
    const amount = task[MEMORY.MEMORY_ORDER_AMOUNT] as number;
    const currentAmount = terminal.store.getUsedCapacity(resource);
    let missingAmount = amount - currentAmount;

    trace.log('buy order', {
      resource,
      amount,
      currentAmount,
      missingAmount,
    });

    // Buy in at least blocks of 1000, to avoid stupid small orders
    missingAmount = Math.max(1000, missingAmount);

    if (currentAmount >= amount) {
      trace.log('buy order satisfied');
      this.clearTask(trace);
      return;
    }

    if (terminal.cooldown) {
      trace.log('buy order failed: cooling down');
      return;
    }

    let orders = Game.market.getAllOrders({type: ORDER_SELL, resourceType: resource});
    if (!orders.length) {
      trace.log('buy order failed: no energy for sale');
      this.clearTask(trace);
      return;
    }

    const order = _.sortBy(orders, 'price')[0];
    if (order.price > MARKET.PRICES[resource].buy) {
      trace.log('buy order failed: costs to much');
      this.clearTask(trace);
      return;
    }

    let dealAmount = Math.min(missingAmount, order.remainingAmount);
    let haulAmount = dealAmount;
    trace.log('deal amount', {dealAmount, resource});

    const energyRequired = Game.market.calcTransactionCost(missingAmount, terminal.room.name, order.roomName);
    // If we are transfering energy we need energy in addition to what we want to transfer
    if (resource === RESOURCE_ENERGY) {
      haulAmount += energyRequired;
      trace.log('padded haul amount', {haulAmount, added: energyRequired});
    }

    const energyReady = this.haulTransferEnergyToTerminal(terminal, resource, haulAmount, order.roomName, trace);
    if (!energyReady) {
      trace.log('deal energy not ready')
      return;
    }

    const result = Game.market.deal(order.id, dealAmount, terminal.room.name);
    trace.log('deal result', {orderId: order.id, missingAmount, dealAmount, destRoom: terminal.room.name, energyRequired, result});
  }

  sell(terminal: StructureTerminal, task, trace: Tracer) {
    const resource = task[MEMORY.MEMORY_ORDER_RESOURCE];
    const amount = task[MEMORY.MEMORY_ORDER_AMOUNT];
    const phase = task[MEMORY.TASK_PHASE] || TASK_PHASE_HAUL_RESOURCE;

    switch (phase) {
      case TASK_PHASE_HAUL_RESOURCE:
        // Check if we should move to next phase
        const terminalAmount = terminal.store.getUsedCapacity(resource);
        if (terminalAmount >= amount) {
          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TASK_PHASE] = TASK_PHASE_TRANSACT;
          break;
        }

        const pickup = this.orgRoom.getReserveStructureWithMostOfAResource(resource, false);
        if (!pickup) {
          if (!terminalAmount) {

            this.clearTask(trace);
            break;
          }


          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.TASK_PHASE] = TASK_PHASE_TRANSACT;
          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.MEMORY_ORDER_AMOUNT] = terminalAmount;
          break;
        }

        this.haulResourceToTerminal(terminal, pickup, resource, amount);
        break;
      case TASK_PHASE_TRANSACT:
        // Check if we are done selling
        if (terminal.store.getUsedCapacity(resource) === 0 || amount < 1) {
          this.clearTask(trace);
          break;
        }

        let orders = Game.market.getAllOrders({type: ORDER_BUY, resourceType: resource});

        orders = orders.filter((order) => {
          return order.remainingAmount > 0;
        });

        orders = _.sortBy(orders, 'price').reverse();
        const order = orders[0];

        if (!orders.length || order.price < MARKET.PRICES[resource].sell) {
          // Check if we already have a sell order for the room and resource
          const duplicateBuyOrders = Object.values(Game.market.orders).filter((order) => {
            return order.type === ORDER_SELL && order.resourceType === resource &&
              order.roomName === terminal.room.name && order.remainingAmount > 0;
          });
          if (duplicateBuyOrders.length) {

            //  `${JSON.stringify(duplicateBuyOrders)}`)
            this.clearTask(trace);
            return;
          }

          if (!MARKET.PRICES[resource]) {

            this.clearTask(trace);
            return;
          }

          const price = MARKET.PRICES[resource].sell;

          // Create buy order
          const order = {
            type: ORDER_SELL,
            resourceType: resource,
            price: price,
            totalAmount: amount,
            roomName: terminal.room.name,
          };
          const result = Game.market.createOrder(order);
          if (result != OK) {

          }

          this.clearTask(trace);
          return;
        }

        const dealAmount = _.min([amount, order.remainingAmount]);
        const energyReady = this.haulTransferEnergyToTerminal(terminal, resource, dealAmount,
          order.roomName, trace);
        if (!energyReady) {
          return;
        }

        if (terminal.cooldown) {
          return;
        }

        const result = Game.market.deal(order.id, dealAmount, terminal.room.name);

        if (result == OK) {
          terminal.room.memory[MEMORY.TERMINAL_TASK].details[MEMORY.MEMORY_ORDER_AMOUNT] -= dealAmount;
        }

        break;
      default:
        trace.error('BROKEN MARKET LOGIC', phase);
        this.clearTask(trace);
    }
  }

  updateOrders(terminal: StructureTerminal, trace: Tracer) {
    // Check if we already have a sell order for the room and resource
    Object.values(Game.market.orders).filter((order) => {
      return order.roomName === terminal.room.name;
    }).forEach((order) => {
      if (order.remainingAmount === 0) {
        trace.log('order is complete; cancelling', {orderId: order.id});
        Game.market.cancelOrder(order.id);
        return;
      }

      const missingAmount = order.amount - order.remainingAmount;
      if (missingAmount > 0) {
        const pickup = this.orgRoom.getReserveStructureWithMostOfAResource(order.resourceType, false);
        if (!pickup) {
          trace.log('order missing resource and no pickup; cancelling',
            {orderId: order.id, missingAmount, resource: order.resourceType});
          Game.market.cancelOrder(order.id);
        } else {
          trace.log('requesting hauling of missing resource',
            {orderId: order.id, missingAmount, resource: order.resourceType});
          this.haulResourceToTerminal(terminal, pickup, order.resourceType, order.remainingAmount - order.amount);
        }
      }

      if (!MARKET.PRICES[order.resourceType]) {
        trace.log(`no price set for resource`, {resource: order.resourceType, orderId: order.id});
        return;
      }

      let price = MARKET.PRICES[order.resourceType].sell;
      if (order.type === ORDER_BUY) {
        price = MARKET.PRICES[order.resourceType].buy;
      }

      if (order.price !== price) {
        Game.market.changeOrderPrice(order.id, price);
        trace.log('updating order price', {
          orderId: order.id,
          previousPrice: order.price, newPrice: price, resource: order.resourceType,
        });
      }
    });
  }

  haulResourceToTerminal(terminal: StructureTerminal, pickup, resource, amount) {
    const numHaulers = this.orgRoom.getCreeps().filter((creep) => {
      return creep.memory[MEMORY.MEMORY_TASK_TYPE] === TASKS.HAUL_TASK &&
        creep.memory[MEMORY.MEMORY_HAUL_RESOURCE] === resource &&
        creep.memory[MEMORY.MEMORY_HAUL_DROPOFF] === terminal.id;
    }).length;

    // If we already have a hauler assigned, don't assign more
    if (numHaulers) {
      return;
    }

    this.sendHaulRequest(terminal, pickup, resource, amount, 0.8);
  }

  haulTransferEnergyToTerminal(terminal: StructureTerminal, resource: ResourceConstant,
    amount: number, destinationRoom: string, trace: Tracer) {
    const currentEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
    if (currentEnergy < amount) {
      // If we are low on energy don't take any from reserve
      if (this.orgRoom.getAmountInReserve(RESOURCE_ENERGY) > 20000) {
        const pickup = this.orgRoom.getReserveStructureWithMostOfAResource(RESOURCE_ENERGY, false);
        if (!pickup) {
          return false;
        }

        const requestAmount = amount - currentEnergy;
        trace.log('requesting', {resource, amount: requestAmount});
        this.sendHaulRequest(terminal, pickup, RESOURCE_ENERGY, requestAmount, 1);
        return false;
      }

      return false;
    }

    return true;
  }

  sendHaulRequest(terminal: StructureTerminal, pickup: AnyStoreStructure, resource: ResourceConstant, amount: number, priority: number) {
    amount = _.min([amount, pickup.store.getUsedCapacity(resource)]);

    const details = {
      [MEMORY.TASK_ID]: `mrl-${terminal.id}-${Game.time}`,
      [MEMORY.MEMORY_TASK_TYPE]: TASKS.HAUL_TASK,
      [MEMORY.MEMORY_HAUL_PICKUP]: pickup.id,
      [MEMORY.MEMORY_HAUL_RESOURCE]: resource,
      [MEMORY.MEMORY_HAUL_AMOUNT]: amount,
      [MEMORY.MEMORY_HAUL_DROPOFF]: terminal.id,
    };

    (this.orgRoom as any).sendRequest(TOPICS.HAUL_CORE_TASK, priority, details, PROCESS_TASK_TTL);
  }

  sendEnergyToStorage(terminal: StructureTerminal, amount: number, ttl: number, trace: Tracer) {
    const reserve = this.orgRoom.getReserveStructureWithRoomForResource(RESOURCE_ENERGY);
    if (!reserve) {
      trace.log('could not find dropoff for energy', {amount});
      return;
    }

    trace.log('sending request to haul energy from terminal', {amount, dropoff: reserve.id});

    const details = {
      [MEMORY.TASK_ID]: `meu-${terminal.id}-${Game.time}`,
      [MEMORY.MEMORY_TASK_TYPE]: TASKS.HAUL_TASK,
      [MEMORY.MEMORY_HAUL_PICKUP]: terminal.id,
      [MEMORY.MEMORY_HAUL_RESOURCE]: RESOURCE_ENERGY,
      [MEMORY.MEMORY_HAUL_AMOUNT]: amount,
      [MEMORY.MEMORY_HAUL_DROPOFF]: reserve.id,
    };
    (this.orgRoom as any).sendRequest(TOPICS.HAUL_CORE_TASK, 1.0, details, ttl);
  }
}
