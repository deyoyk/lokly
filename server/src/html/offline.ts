export const TUNNEL_OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>tunnel offline — lokly</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Fira Code", "Courier New", monospace;
      background: #000;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 600px; width: 100%; }
    .header { border-bottom: 1px solid #333; padding-bottom: 1.5rem; margin-bottom: 2rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: #555; text-transform: uppercase; letter-spacing: 0.15em; }
    .status { margin-bottom: 3rem; }
    .status .code { font-size: 3rem; font-weight: 700; color: #ff4444; margin-bottom: 0.5rem; }
    .status .msg { color: #aaa; font-size: 1rem; }
    .info { color: #555; font-size: 0.85rem; line-height: 1.7; }
    .info a { color: #fff; text-decoration: none; border-bottom: 1px solid #333; }
    .info a:hover { border-bottom-color: #fff; }
    .footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #111; font-size: 0.75rem; color: #fff; }
    .footer a { color: #555; text-decoration: none; }
    .footer a:hover { color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>lokly</h1></div>
    <div class="status">
      <div class="code">502</div>
      <div class="msg">tunnel not connected</div>
    </div>
    <div class="info">
      no active tunnel for this URL.<br>
      start one with<br><br>
      <span style="color:#fff;">npx @deyoyk/lokly &lt;port&gt;</span>
    </div>
    <div class="footer">
      made with &lt;3 by <a href="https://github.com/deyoyk" style="color:#b388ff;">deyo</a>
    </div>
  </div>
</body>
</html>`;
