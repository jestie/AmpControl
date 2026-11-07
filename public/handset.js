/*
 * The Marantz RC004PM handset: the real remote's photo with a hotspot over
 * every button. Pressing one asks the server to do that button's job
 * (src/remote.js) and shows what the amp reported.
 *
 * Coordinates are button centres in public/img/rc004pm.png (203 x 817),
 * measured from the photo; w/h are the button size.
 */
(() => {
  'use strict';

  const W = 203;
  const H = 817;
  const PILL = { w: 36, h: 18 };
  const NUM = { w: 36, h: 21 };
  const ROUND = { w: 36, h: 36 };
  const SMALL = { w: 26, h: 24 };
  const BAR = { w: 28, h: 14 };

  // key: what the server does; local: handled in the page; info: not for this amp.
  const BUTTONS = [
    { x: 42, y: 60, ...SMALL, info: 'CD power: for a Marantz CD player, not the amp.', label: 'CD power' },
    { x: 80, y: 61, w: 28, h: 15, info: 'Remote mode CD: switches the handset to a Marantz CD player.', label: 'Remote mode CD' },
    { x: 119, y: 61, w: 28, h: 15, info: 'Remote mode AMP: this remote is always in AMP mode.', label: 'Remote mode AMP' },
    { x: 158, y: 60, ...SMALL, key: 'amp_power', label: 'AMP power' },

    { x: 48, y: 103, ...PILL, local: 'internet_radio', label: 'Internet radio' },
    { x: 99, y: 103, ...PILL, key: 'src_usb', label: 'USB' },
    { x: 151, y: 103, ...PILL, key: 'src_servers', label: 'Music servers' },
    { x: 48, y: 138, ...PILL, key: 'src_aux', label: 'AUX' },
    { x: 99, y: 138, ...PILL, key: 'src_recorder', label: 'Recorder' },
    { x: 151, y: 138, ...PILL, key: 'src_optcoax', label: 'Optical / coaxial' },
    { x: 48, y: 174, ...PILL, key: 'src_cd', label: 'CD input' },
    { x: 99, y: 174, ...PILL, key: 'src_bluetooth', label: 'Bluetooth' },
    { x: 151, y: 174, ...PILL, key: 'src_phono', label: 'Phono' },

    { x: 48, y: 209, ...PILL, key: 'previous', label: 'Previous' },
    { x: 99, y: 209, ...PILL, key: 'play_pause', label: 'Play / pause' },
    { x: 151, y: 209, ...PILL, key: 'next', label: 'Next' },
    { x: 48, y: 247, ...PILL, local: 'fav_call', label: 'Favorites call' },
    { x: 99, y: 247, ...PILL, key: 'stop', label: 'Stop' },
    { x: 151, y: 247, ...PILL, key: 'fav_add', label: 'Favorites add' },

    { x: 48, y: 293, ...ROUND, key: 'input', label: 'Input' },
    { x: 99, y: 292, w: 27, h: 27, key: 'source_direct', label: 'Source direct' },
    { x: 151, y: 293, ...ROUND, key: 'vol_up', label: 'Volume up', repeat: true },
    { x: 48, y: 343, ...ROUND, key: 'info', label: 'Info' },
    { x: 99, y: 342, w: 27, h: 27, key: 'mute', label: 'Mute' },
    { x: 151, y: 343, ...ROUND, key: 'vol_down', label: 'Volume down', repeat: true },
    { x: 40, y: 394, w: 26, h: 26, info: 'Queue shows the play queue on the amp\'s display; the Radio tab is the easier way here.', label: 'Queue' },
    { x: 156, y: 394, w: 26, h: 26, key: 'option', label: 'Option' },

    { x: 99, y: 411, w: 34, h: 20, key: 'up', label: 'Up' },
    { x: 99, y: 491, w: 34, h: 20, key: 'down', label: 'Down' },
    { x: 59, y: 451, w: 20, h: 34, key: 'left', label: 'Left' },
    { x: 139, y: 451, w: 20, h: 34, key: 'right', label: 'Right' },
    { x: 99, y: 451, w: 38, h: 38, key: 'enter', label: 'Enter' },
    { x: 43, y: 507, w: 26, h: 26, key: 'back', label: 'Back' },
    { x: 155, y: 507, w: 26, h: 26, key: 'setup', label: 'Setup' },

    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      x: [48, 99, 151][(n - 1) % 3], y: [552, 588, 624][Math.floor((n - 1) / 3)], ...NUM, key: `num_${n}`, label: `Favourite ${n}`
    })),
    { x: 48, y: 660, ...NUM, info: '+10 picks favourites above 9 or changes letter case when typing on the amp.', label: '+10' },
    { x: 99, y: 660, ...NUM, info: '0 is used for typing names on the amp\'s display.', label: '0' },
    { x: 151, y: 660, ...NUM, info: 'Clear cancels a setting while typing on the amp\'s display.', label: 'Clear' },

    { x: 44, y: 701, ...BAR, key: 'dimmer', label: 'Dimmer' },
    { x: 81, y: 701, ...BAR, key: 'random', label: 'Random' },
    { x: 117, y: 701, ...BAR, key: 'repeat', label: 'Repeat' },
    { x: 154, y: 701, ...BAR, key: 'sleep', label: 'Sleep' }
  ];

  function create({ post, refresh, toast, local }) {
    const root = document.createElement('div');
    root.className = 'handset';
    const img = document.createElement('img');
    img.src = '/img/rc004pm.png';
    img.alt = 'Marantz RC004PM remote control';
    img.draggable = false;
    const lcd = document.createElement('div');
    lcd.className = 'handset-lcd';
    lcd.setAttribute('role', 'status');
    lcd.setAttribute('aria-live', 'polite');
    lcd.textContent = 'Press a button';
    root.append(lcd);
    const pad = document.createElement('div');
    pad.className = 'handset-pad';
    pad.style.aspectRatio = `${W} / ${H}`;
    pad.append(img);
    root.append(pad);

    let lcdTimer = null;
    function show(text, tone = '') {
      lcd.textContent = text;
      lcd.className = `handset-lcd ${tone}`;
      clearTimeout(lcdTimer);
      lcdTimer = setTimeout(() => { lcd.textContent = 'Press a button'; lcd.className = 'handset-lcd'; }, 4000);
    }

    let busy = Promise.resolve();
    let refreshTimer = null;
    function press(button, node) {
      node.classList.remove('pressed');
      void node.offsetWidth; // restart the flash animation
      node.classList.add('pressed');
      if (button.info) { show(button.info, 'muted'); return; }
      if (button.local) { show(button.label); local(button.local); return; }
      // One command at a time, in order, like a real remote.
      busy = busy.then(async () => {
        try {
          const result = await post('remote', { key: button.key });
          show(result.verified === false ? `${button.label}: sent, check the amp display` : result.message, result.verified === false ? 'warn' : 'ok');
        } catch (e) {
          show(e.message, 'error');
          toast(e.message);
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 400);
      });
    }

    for (const button of BUTTONS) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `hs-btn${button.info ? ' na' : ''}`;
      node.title = button.label;
      node.setAttribute('aria-label', button.label);
      node.style.left = `${((button.x - button.w / 2) / W) * 100}%`;
      node.style.top = `${((button.y - button.h / 2) / H) * 100}%`;
      node.style.width = `${(button.w / W) * 100}%`;
      node.style.height = `${(button.h / H) * 100}%`;
      if (button.repeat) {
        // Hold volume to keep going, like the real button.
        let holdTimer = null;
        const stop = () => { clearInterval(holdTimer); holdTimer = null; };
        node.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          press(button, node);
          stop();
          holdTimer = setInterval(() => press(button, node), 350);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => node.addEventListener(type, stop));
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); press(button, node); }
        });
      } else {
        node.addEventListener('click', () => press(button, node));
      }
      pad.append(node);
    }
    return { root };
  }

  window.Handset = { create };
})();
