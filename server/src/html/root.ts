export const ROOT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lokly</title>
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
    .container {
      max-width: 600px;
      width: 100%;
    }
    .header {
      border-bottom: 1px solid #333;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    .header h1 {
      font-size: 1rem;
      font-weight: 400;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.15em;
    }
    .hero {
      margin-bottom: 3rem;
    }
    .hero .prompt {
      color: #555;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
    }
    .hero .cmd {
      font-size: 1.3rem;
      color: #fff;
      padding: 1rem 0;
      border-bottom: 1px solid #222;
      user-select: all;
    }
    .hero .cmd span {
      color: #555;
    }
    .section {
      margin-bottom: 2.5rem;
    }
    .section h2 {
      font-size: 0.7rem;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 1rem;
    }
    .section p {
      color: #aaa;
      font-size: 0.85rem;
      line-height: 1.7;
    }
    .section a {
      color: #fff;
      text-decoration: none;
      border-bottom: 1px solid #333;
    }
    .section a:hover {
      border-bottom-color: #fff;
    }
    .steps {
      list-style: none;
    }
    .steps li {
      color: #aaa;
      font-size: 0.85rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid #111;
      display: flex;
      gap: 1rem;
    }
    .steps li::before {
      content: ">";
      color: #555;
      flex-shrink: 0;
    }
    .footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid #111;
      font-size: 0.75rem;
      color: #fff;
    }
    .footer a {
      color: #555;
      text-decoration: none;
    }
    .footer a:hover {
      color: #fff;
    }
    .cursor {
      display: inline-block;
      width: 0.6em;
      height: 1em;
      background: #fff;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% { opacity: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>lokly</h1>
    </div>

    <div class="hero">
      <div class="prompt">// expose localhost to the internet</div>
      <div class="cmd"><span>$</span> npx @deyoyk/lokly 3000 --subdomain myname<span class="cursor"></span></div>
    </div>

    <div class="section">
      <h2>usage</h2>
      <ol class="steps">
        <li>run your local server on any port</li>
        <li>run <span style="color:#fff;">npx @deyoyk/lokly &lt;port&gt;</span></li>
        <li>add <span style="color:#fff;">--subdomain &lt;name&gt;</span> for a custom url: <span style="color:#fff;">&lt;name&gt;.heydeyo.lol</span></li>
        <li>share the generated url</li>
      </ol>
    </div>

    <div class="footer">
      made with &lt;3 by <a href="https://github.com/deyoyk" style="color:#b388ff;">deyo</a>
    </div>
  </div>
</body>
</html>`;
