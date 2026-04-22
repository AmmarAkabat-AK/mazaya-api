const { RouterOSClient } = require('routeros-client');

(async () => {
  const api = new RouterOSClient({
    host: 'ce9e0c0310fa.sn.mynetname.net',
    user: 'ali3',
    password: '9623#6010',
    port: 8729,
    secure: true
  });

  const conn = await api.connect();

  const menu = conn.menu('/tool/user-manager/user');

  const rows = await menu.where('username', '47073983').get();

  console.log(rows);

  await api.close();
})();
