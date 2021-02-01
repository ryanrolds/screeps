
const doEvery = ttl => action => {
  let lastCall = 0;

  const tick = function() {
    if (Game.time > lastCall + ttl) {
      lastCall = Game.time
      return action.apply(null, arguments)
    }

    return null
  }

  tick.reset = () => {
    lastCall = 0;
  };

  return tick
}

module.exports = {
  doEvery,
}