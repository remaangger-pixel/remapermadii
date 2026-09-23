module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://anvicreate.web.id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, message: "dash-proxy route is alive" }));
};
