const Kingdom = require('./org.kingdom');
const tracing = require('./lib.tracing');

class AI {
  constructor(config) {
    const trace = tracing.startTrace('ai_constructor');

    this.config = config;

    this.kingdom = new Kingdom(config, trace);

    trace.end();
  }

  tick(trace) {
    console.log("asdfasdf")

    trace = trace.begin('tick');

    this.kingdom.update(trace)
    this.kingdom.process(trace);

    trace.end();
  }
}

module.exports = AI;