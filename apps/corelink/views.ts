import type { Theme } from "./theme.js";
import {
  type Account,
  type Member,
  SUB_ACCOUNT_TYPES,
  availableCents,
  fmtMoney,
  fullName,
  maskSsn,
} from "./data.js";

export function h(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DOCTYPE = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';

function head(t: Theme, title: string, extra = ""): string {
  return `<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${h(t.appName)} - ${h(title)}</title>
<meta name="generator" content="${h(t.vendorBuild)}">${extra}</head>`;
}

/** A page rendered inside the main frame. */
export function mainPage(t: Theme, title: string, screenCode: string, body: string, extraHead = ""): string {
  return `${DOCTYPE}
<html>${head(t, title, extraHead)}
<body bgcolor="${t.colors.pageBg}" style="margin:4px;font-family:${t.font};font-size:12px">
<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
<td style="background:${t.colors.tableHead};color:#fff;padding:2px 6px"><font face="${t.font}" size="2"><b>${h(title)}</b></font></td>
<td align="right" style="background:${t.colors.tableHead};color:#fff;padding:2px 6px;font-size:10px">${h(screenCode)}</td>
</tr></table>
<table width="100%" border="0" cellpadding="6" cellspacing="0"><tr><td>
${body}
</td></tr></table>
</body></html>`;
}

function errorBanner(t: Theme, msg: string | undefined): string {
  if (!msg) return "";
  return `<table border="1" cellpadding="4" cellspacing="0" bordercolor="${t.colors.error}" style="margin-bottom:8px"><tr>
<td bgcolor="#ffffe0"><font color="${t.colors.error}"><b>${h(msg)}</b></font></td></tr></table>`;
}

// ---------------------------------------------------------------- login / shell

export function loginPage(t: Theme, opts: { banner?: string; error?: string }): string {
  const L = t.labels;
  return `${DOCTYPE}
<html>${head(t, "Sign On", `<script type="text/javascript">if (top !== self) { top.location.href = self.location.href; }</script>`)}
<body bgcolor="${t.colors.headerBg}" style="font-family:${t.font}">
<center>
<br><br>
<table width="420" border="2" cellpadding="0" cellspacing="0" bgcolor="${t.colors.pageBg}">
<tr><td style="background:${t.colors.headerBg};color:${t.colors.headerFg};padding:6px">
<font size="4"><b>${h(t.appName)}</b></font><br><font size="1">${h(t.institution)}</font></td></tr>
<tr><td style="padding:12px">
${opts.banner ? `<table width="100%" border="1" cellpadding="4" cellspacing="0"><tr><td bgcolor="#ffff00" align="center"><font color="#cc0000"><b>${h(opts.banner)}</b></font></td></tr></table><br>` : ""}
${errorBanner(t, opts.error)}
<form method="post" action="${t.prefix}/login">
<table border="0" cellpadding="3" cellspacing="0">
<tr><td colspan="2"><b>${h(L.loginTitle)}</b></td></tr>
<tr><td align="right">${h(L.userLabel)}</td><td><input type="text" name="fld1" size="16" maxlength="16" autocomplete="off"></td></tr>
<tr><td align="right">${h(L.passwordLabel)}</td><td><input type="password" name="fld2" size="16" maxlength="32"></td></tr>
<tr><td></td><td><input type="submit" value="${h(L.signOnButton)}"></td></tr>
</table>
</form>
<font size="1" color="#555555">${h(t.vendorBuild)} &nbsp;|&nbsp; Authorized use only.</font>
</td></tr></table>
</center>
</body></html>`;
}

export function frameset(t: Theme): string {
  const p = t.prefix;
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>${head(t, "Teller Workstation")}
<frameset rows="48,*" border="1" frameborder="1">
  <frame name="hdr" src="${p}/hdr" scrolling="no" noresize>
  <frameset cols="170,*">
    <frame name="nav" src="${p}/nav">
    <frame name="main" src="${p}/main">
  </frameset>
  <noframes><body>This application requires a frames-capable browser.</body></noframes>
</frameset>
</html>`;
}

export function headerFrame(t: Theme, operator: string): string {
  return `${DOCTYPE}
<html>${head(t, "Header")}
<body bgcolor="${t.colors.headerBg}" style="margin:0;font-family:${t.font}">
<table width="100%" height="46" border="0" cellpadding="4" cellspacing="0"><tr>
<td><font color="${t.colors.headerFg}" size="4"><b>${h(t.appName)}</b></font> <font color="${t.colors.headerFg}" size="1">${h(t.institution)}</font></td>
<td align="right"><font color="${t.colors.headerFg}" size="1">OPR: ${h(operator.toUpperCase())} &nbsp; BR: 004 &nbsp; WS: T04-02<br>${h(t.vendorBuild)}</font></td>
</tr></table>
</body></html>`;
}

export function navFrame(t: Theme): string {
  const p = t.prefix;
  const L = t.labels;
  return `${DOCTYPE}
<html>${head(t, "Menu")}
<body bgcolor="${t.colors.navBg}" style="margin:4px;font-family:${t.font};font-size:12px">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr><td style="background:${t.colors.tableHead};color:#fff"><b>FUNCTIONS</b></td></tr>
<tr><td><a href="${p}/search" target="main" style="color:${t.colors.navFg}">${h(L.navInquiry)}</a></td></tr>
<tr><td onclick="parent.main.location.href='${p}/unavail'" style="cursor:pointer;color:${t.colors.navFg};text-decoration:underline">${h(L.navDrawer)}</td></tr>
<tr><td><a href="javascript:void(0)" onclick="top.location.href='${p}/logout';return false;" style="color:${t.colors.navFg}">${h(L.navSignOff)}</a></td></tr>
</table>
<br><center><font size="1" color="#555555">F2=INQ F9=SIGNOFF</font></center>
</body></html>`;
}

export function welcomePage(t: Theme, operator: string): string {
  return mainPage(
    t,
    "MAIN MENU",
    "MENU0001",
    `<center><font size="3">Welcome, <b>${h(operator.toUpperCase())}</b>.</font><br><br>${h(t.labels.welcome)}</center>`,
  );
}

export function noticePage(t: Theme): string {
  const L = t.labels;
  return `${DOCTYPE}
<html>${head(t, L.noticeTitle)}
<body bgcolor="${t.colors.pageBg}" style="font-family:${t.font}">
<center><br><br>
<table width="520" border="2" cellpadding="10" cellspacing="0" bgcolor="#ffffff">
<tr><td style="background:${t.colors.headerBg};color:${t.colors.headerFg}"><b>${h(L.noticeTitle)}</b></td></tr>
<tr><td><p>${h(L.noticeText)}</p>
<form method="post" action="${t.prefix}/notice"><center><input type="submit" value="${h(L.noticeButton)}"></center></form>
</td></tr></table></center>
</body></html>`;
}

// ---------------------------------------------------------------- search / results

export function searchPage(t: Theme, opts: { error?: string; message?: string; fld1?: string; fld2?: string; results?: Member[] }): string {
  const L = t.labels;
  let body = `${errorBanner(t, opts.error)}
<form method="post" action="${t.prefix}/search">
<input type="hidden" name="fn" value="MBRINQ">
<table border="1" cellpadding="4" cellspacing="0" bgcolor="#ffffff" bordercolor="#808080">
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.memberNumberLabel)}</td><td><input type="text" name="fld1" size="12" maxlength="10" value="${h(opts.fld1)}"></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.lastNameLabel)}</td><td><input type="text" name="fld2" size="20" maxlength="30" value="${h(opts.fld2)}"></td></tr>
<tr><td colspan="2" align="center"><input type="submit" value="${h(L.searchButton)}"></td></tr>
</table>
</form>`;
  if (opts.message) {
    body += `<br><table border="0" cellpadding="6"><tr><td bgcolor="#ffffcc"><font color="${t.colors.error}"><b>${h(opts.message)}</b></font></td></tr></table>`;
  }
  if (opts.results && opts.results.length) {
    body += resultsTable(t, opts.results);
  }
  const title = opts.results?.length ? L.resultsTitle : L.searchTitle;
  const script = `<script type="text/javascript">function selMbr(n){ window.location.href='${t.prefix}/member?m=' + n; }</script>`;
  return mainPage(t, title, "MBRINQ01", body, script);
}

function resultsTable(t: Theme, rows: Member[]): string {
  const L = t.labels;
  const headers: Record<string, string> = {
    memberNumber: L.colMemberNumber,
    name: L.colName,
    ssn: L.colSsn,
    status: L.colStatus,
    branch: L.colBranch,
  };
  const cell = (m: Member, col: string): string => {
    switch (col) {
      case "memberNumber":
        return `<a href="javascript:selMbr('${h(m.memberNumber)}')">${h(m.memberNumber)}</a>`;
      case "name":
        return h(fullName(m));
      case "ssn":
        return h(maskSsn(m.ssn));
      case "status":
        return m.status === "ACTIVE" ? "ACTIVE" : `<font color="${t.colors.error}">DORMANT</font>`;
      default:
        return h(m.branch);
    }
  };
  const head = t.resultColumns
    .map((c) => `<td style="background:${t.colors.tableHead};color:#fff"><b>${h(headers[c])}</b></td>`)
    .join("");
  const body = rows
    .map(
      (m, i) =>
        `<tr${i % 2 ? ` bgcolor="${t.colors.rowAlt}"` : ` bgcolor="#ffffff"`}>${t.resultColumns.map((c) => `<td>${cell(m, c)}</td>`).join("")}</tr>`,
    )
    .join("\n");
  return `<br><table border="0" cellpadding="0" cellspacing="0"><tr><td>
<table border="1" cellpadding="3" cellspacing="0" bordercolor="#808080">
<tr>${head}</tr>
${body}
</table>
<font size="1">${rows.length} RECORD(S) FOUND</font>
</td></tr></table>`;
}

// ---------------------------------------------------------------- member detail

function accountRows(t: Theme, accounts: Account[]): string {
  return accounts
    .map(
      (a, i) =>
        `<tr bgcolor="${i % 2 ? t.colors.rowAlt : "#ffffff"}"><td>${h(a.suffix)}</td><td>${h(a.description)}${a.nickname ? ` (${h(a.nickname)})` : ""}</td><td align="right">${fmtMoney(a.balanceCents)}</td><td align="right">${fmtMoney(availableCents(a))}</td></tr>`,
    )
    .join("\n");
}

export function memberPage(t: Theme, m: Member): string {
  const L = t.labels;
  const p = t.prefix;
  const body = `<table border="0" cellpadding="0" cellspacing="0"><tr><td valign="top">
<table border="1" cellpadding="3" cellspacing="0" bgcolor="#ffffff" bordercolor="#808080">
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.detailMemberNumber)}</td><td><b>${h(m.memberNumber)}</b></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.detailName)}</td><td>${h(fullName(m))}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.detailSsn)}</td><td>${h(m.ssn)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.detailStatus)}</td><td>${m.status}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">Branch:</td><td>${h(m.branch)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">Opened:</td><td>${h(m.opened)}</td></tr>
</table>
</td><td width="20"></td><td valign="top">
<table border="1" cellpadding="3" cellspacing="0" bordercolor="#808080">
<tr><td style="background:${t.colors.tableHead};color:#fff"><b>Suffix</b></td><td style="background:${t.colors.tableHead};color:#fff"><b>Description</b></td><td style="background:${t.colors.tableHead};color:#fff"><b>Balance</b></td><td style="background:${t.colors.tableHead};color:#fff"><b>Available</b></td></tr>
${accountRows(t, m.accounts)}
</table>
</td></tr></table>
<br>
<table border="0" cellpadding="2"><tr>
<td><form method="get" action="${p}/subacct" style="margin:0"><input type="hidden" name="mbr" value="${h(m.memberNumber)}"><input type="submit" value="${h(L.openSubButton)}"></form></td>
<td>&nbsp;<a href="${p}/search">${h(L.newInquiryLink)}</a></td>
</tr></table>`;
  return mainPage(t, L.detailTitle, "MBRDTL02", body);
}

export function messagePage(t: Theme, title: string, code: string, msg: string, backHref?: string, backText = "Return"): string {
  return mainPage(
    t,
    title,
    code,
    `<center><br><table border="2" cellpadding="10" cellspacing="0" bgcolor="#ffffff" bordercolor="${t.colors.error}"><tr><td align="center">
<font color="${t.colors.error}" size="3"><b>${h(msg)}</b></font></td></tr></table><br>
${backHref ? `<a href="${h(backHref)}">${h(backText)}</a>` : ""}</center>`,
  );
}

// ---------------------------------------------------------------- sub-account

export interface SubForm {
  fld1?: string;
  fld2?: string;
  fld3?: string;
  fld4?: string;
}

export function subAccountForm(t: Theme, m: Member, form: SubForm, error?: string): string {
  const L = t.labels;
  const p = t.prefix;
  const typeOpts = [`<option value="">-- SELECT --</option>`]
    .concat(SUB_ACCOUNT_TYPES.map((s) => `<option value="${s.code}"${form.fld1 === s.code ? " selected" : ""}>${h(s.label)}</option>`))
    .join("");
  const fromOpts = [`<option value="">-- SELECT --</option>`]
    .concat(
      m.accounts.map(
        (a) =>
          `<option value="${h(a.suffix)}"${form.fld4 === a.suffix ? " selected" : ""}>${h(a.suffix)} ${h(a.description)} AVAIL ${fmtMoney(availableCents(a))}</option>`,
      ),
    )
    .join("");
  const body = `${errorBanner(t, error)}
<table border="0" cellpadding="2"><tr><td>Member: <b>${h(m.memberNumber)}</b> ${h(fullName(m))}</td></tr></table>
<form method="post" action="${p}/subacct">
<input type="hidden" name="mbr" value="${h(m.memberNumber)}">
<table border="1" cellpadding="4" cellspacing="0" bgcolor="#ffffff" bordercolor="#808080">
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.typeLabel)}</td><td><select name="fld1">${typeOpts}</select></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.nicknameLabel)}</td><td><input type="text" name="fld2" size="22" maxlength="40" value="${h(form.fld2)}"> <font size="1">(optional, max 20)</font></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.depositLabel)}</td><td><input type="text" name="fld3" size="12" value="${h(form.fld3)}"></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}" align="right">${h(L.fromLabel)}</td><td><select name="fld4">${fromOpts}</select></td></tr>
<tr><td colspan="2" align="center"><input type="submit" value="${h(L.continueButton)}"> &nbsp; <a href="javascript:void(0)" onclick="window.location.href='${p}/member?m=${h(m.memberNumber)}';return false;">${h(L.cancelLink)}</a></td></tr>
</table>
</form>`;
  return mainPage(t, L.subTitle, "SUBOPN03", body);
}

export interface PendingSub {
  token: string;
  memberNumber: string;
  type: string;
  nickname: string;
  amountCents: number;
  fromSuffix: string;
}

export function reviewPage(t: Theme, m: Member, pend: PendingSub): string {
  const L = t.labels;
  const p = t.prefix;
  const type = SUB_ACCOUNT_TYPES.find((s) => s.code === pend.type);
  const from = m.accounts.find((a) => a.suffix === pend.fromSuffix);
  const body = `<table border="1" cellpadding="4" cellspacing="0" bgcolor="#ffffff" bordercolor="#808080">
<tr><td bgcolor="${t.colors.rowAlt}">Member:</td><td>${h(m.memberNumber)} ${h(fullName(m))}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.typeLabel)}</td><td>${h(type?.label ?? pend.type)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.nicknameLabel)}</td><td>${h(pend.nickname || "(none)")}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.depositLabel)}</td><td>${fmtMoney(pend.amountCents)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.fromLabel)}</td><td>${h(pend.fromSuffix)} ${h(from?.description ?? "")}</td></tr>
</table>
<p><font color="${t.colors.error}"><b>WARNING: POSTING IS FINAL. THIS TRANSACTION CANNOT BE REVERSED.</b></font></p>
<table border="0" cellpadding="2"><tr>
<td><form method="post" action="${p}/subacct/commit" style="margin:0"><input type="hidden" name="tk" value="${h(pend.token)}"><input type="submit" name="btn" value="${h(L.submitButton)}"></form></td>
<td><form method="get" action="${p}/subacct" style="margin:0"><input type="hidden" name="mbr" value="${h(m.memberNumber)}"><input type="hidden" name="tk" value="${h(pend.token)}"><input type="submit" value="${h(L.backButton)}"></form></td>
<td>&nbsp;<a href="javascript:void(0)" onclick="window.location.href='${p}/member?m=${h(m.memberNumber)}';return false;">${h(L.cancelLink)}</a></td>
</tr></table>`;
  return mainPage(t, L.reviewTitle, "SUBOPN04", body);
}

export function confirmPage(
  t: Theme,
  m: Member,
  created: { confirmation: string; suffix: string; description: string; amountCents: number; fromSuffix: string },
  duplicate = false,
): string {
  const L = t.labels;
  const body = `${duplicate ? errorBanner(t, "DUPLICATE SUBMISSION - TRANSACTION ALREADY POSTED") : ""}
<table border="1" cellpadding="4" cellspacing="0" bgcolor="#ffffff" bordercolor="#808080">
<tr><td bgcolor="${t.colors.rowAlt}">${h(L.confirmNumberLabel)}</td><td><b>${h(created.confirmation)}</b></td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">Member:</td><td>${h(m.memberNumber)} ${h(fullName(m))}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">New Account:</td><td>${h(created.suffix)} ${h(created.description)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">Amount:</td><td>${fmtMoney(created.amountCents)}</td></tr>
<tr><td bgcolor="${t.colors.rowAlt}">Funded From:</td><td>${h(created.fromSuffix)}</td></tr>
</table><br>
<a href="${t.prefix}/member?m=${h(m.memberNumber)}">${h(L.returnToMemberLink)}</a>`;
  return mainPage(t, L.confirmTitle, "SUBOPN05", body);
}

// ---------------------------------------------------------------- fault screens

export function maintenanceDialog(t: Theme, method: string, action: string, fields: [string, string][]): string {
  const hidden = fields.map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`).join("");
  const body = `<center><br>
<table width="460" border="3" cellpadding="10" cellspacing="0" bgcolor="#ffffcc" bordercolor="#cc6600">
<tr><td style="background:#cc6600;color:#fff"><b>*** SYSTEM NOTICE ***</b></td></tr>
<tr><td><font size="3"><b>System maintenance tonight</b></font><br><br>
Core processing will be unavailable from 11:00 PM to 2:00 AM. Please complete all teller transactions before 10:45 PM.<br><br>
<form method="${method === "POST" ? "post" : "get"}" action="${h(action)}" style="margin:0">${hidden}<input type="hidden" name="__ack" value="1">
<center><input type="submit" value="Acknowledge"></center></form>
</td></tr></table></center>`;
  return mainPage(t, "SYSTEM NOTICE", "SYSMSG99", body);
}

export function serverErrorPage(t: Theme, incident: string, path: string): string {
  return `${DOCTYPE}
<html><head><title>500 Internal Server Error</title></head>
<body bgcolor="#ffffff" style="font-family:Courier New, monospace">
<h2>CLX-0500 UNHANDLED EXCEPTION</h2>
<p>The server encountered an internal error and was unable to complete your request. Incident: ${h(incident)}</p>
<pre>com.corelink.core.CoreHostException: HOST LINK TIMEOUT (RC=0x8E) processing ${h(path)}
	at com.corelink.core.host.SymLink.transact(SymLink.java:418)
	at com.corelink.teller.svc.MbrInqSvc.lookup(MbrInqSvc.java:212)
	at com.corelink.teller.web.TellerServlet.dispatch(TellerServlet.java:97)
	at javax.servlet.http.HttpServlet.service(HttpServlet.java:729)
	at org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)
Caused by: java.net.SocketTimeoutException: Read timed out
	at java.net.SocketInputStream.socketRead0(Native Method)
	... 14 more</pre>
<hr><address>${h(t.vendorBuild)} / Apache Tomcat/6.0.53</address>
</body></html>`;
}

export function notFoundPage(path: string): string {
  return `${DOCTYPE}
<html><head><title>404 Not Found</title></head><body><h1>HTTP Status 404 - ${h(path)}</h1><p>The requested resource is not available.</p></body></html>`;
}
