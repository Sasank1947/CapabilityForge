export type TenantId = "a" | "b";

export type ResultColumn = "memberNumber" | "name" | "ssn" | "status" | "branch";

export interface Theme {
  tenant: TenantId;
  /** Route prefix for every tenant page ("" for tenant A). */
  prefix: string;
  appName: string;
  institution: string;
  /** Vendor fingerprint string; identical vendor build across tenants. */
  vendorBuild: string;
  confPrefix: string;
  font: string;
  colors: {
    pageBg: string;
    headerBg: string;
    headerFg: string;
    navBg: string;
    navFg: string;
    tableHead: string;
    rowAlt: string;
    error: string;
  };
  resultColumns: ResultColumn[];
  /** Extra "Acknowledge notice" interstitial right after login. */
  postLoginNotice: boolean;
  labels: {
    loginTitle: string;
    userLabel: string;
    passwordLabel: string;
    signOnButton: string;
    navInquiry: string;
    navDrawer: string;
    navSignOff: string;
    welcome: string;
    searchTitle: string;
    memberNumberLabel: string;
    lastNameLabel: string;
    searchButton: string;
    resultsTitle: string;
    colMemberNumber: string;
    colName: string;
    colSsn: string;
    colStatus: string;
    colBranch: string;
    detailTitle: string;
    detailMemberNumber: string;
    detailName: string;
    detailSsn: string;
    detailStatus: string;
    openSubButton: string;
    newInquiryLink: string;
    subTitle: string;
    typeLabel: string;
    nicknameLabel: string;
    depositLabel: string;
    fromLabel: string;
    continueButton: string;
    cancelLink: string;
    reviewTitle: string;
    submitButton: string;
    backButton: string;
    confirmTitle: string;
    confirmNumberLabel: string;
    returnToMemberLink: string;
    noticeTitle: string;
    noticeText: string;
    noticeButton: string;
  };
}

const baseLabels: Theme["labels"] = {
  loginTitle: "OPERATOR SIGN ON",
  userLabel: "Operator ID:",
  passwordLabel: "Password:",
  signOnButton: "Sign On",
  navInquiry: "Member Inquiry",
  navDrawer: "Teller Drawer",
  navSignOff: "Sign Off",
  welcome: "Select a function from the menu.",
  searchTitle: "MEMBER INQUIRY",
  memberNumberLabel: "Member Number:",
  lastNameLabel: "Last Name:",
  searchButton: "Search",
  resultsTitle: "MEMBER INQUIRY RESULTS",
  colMemberNumber: "Member Number",
  colName: "Name",
  colSsn: "SSN",
  colStatus: "Status",
  colBranch: "Branch",
  detailTitle: "MEMBER DETAIL",
  detailMemberNumber: "Member Number:",
  detailName: "Name:",
  detailSsn: "SSN:",
  detailStatus: "Status:",
  openSubButton: "Open Sub-Account",
  newInquiryLink: "New Inquiry",
  subTitle: "OPEN SUB-ACCOUNT",
  typeLabel: "Account Type:",
  nicknameLabel: "Nickname:",
  depositLabel: "Initial Deposit:",
  fromLabel: "Transfer From:",
  continueButton: "Continue",
  cancelLink: "Cancel",
  reviewTitle: "REVIEW SUB-ACCOUNT - CONFIRM",
  submitButton: "Submit",
  backButton: "Back",
  confirmTitle: "TRANSACTION POSTED",
  confirmNumberLabel: "Confirmation Number:",
  returnToMemberLink: "Return to Member",
  noticeTitle: "",
  noticeText: "",
  noticeButton: "",
};

export const THEMES: Record<TenantId, Theme> = {
  a: {
    tenant: "a",
    prefix: "",
    appName: "CoreLink Teller",
    institution: "First Community Credit Union",
    vendorBuild: "CoreLink Teller v7.4.2 (build 2291)",
    confPrefix: "CL",
    font: "Arial, Helvetica",
    colors: {
      pageBg: "#d4d0c8",
      headerBg: "#000080",
      headerFg: "#ffffff",
      navBg: "#c0c0c0",
      navFg: "#000080",
      tableHead: "#808080",
      rowAlt: "#e8e8e8",
      error: "#cc0000",
    },
    resultColumns: ["memberNumber", "name", "ssn", "status", "branch"],
    postLoginNotice: false,
    labels: baseLabels,
  },
  b: {
    tenant: "b",
    prefix: "/mcu",
    appName: "MeridianCU Teller",
    institution: "Meridian Credit Union",
    vendorBuild: "CoreLink Teller v7.4.2 (build 2291)",
    confPrefix: "MC",
    font: "Verdana, Tahoma",
    colors: {
      pageBg: "#f3efe0",
      headerBg: "#004d40",
      headerFg: "#ffd54f",
      navBg: "#e0e8e0",
      navFg: "#004d40",
      tableHead: "#00695c",
      rowAlt: "#eef5ee",
      error: "#b00020",
    },
    resultColumns: ["name", "status", "memberNumber", "ssn", "branch"],
    postLoginNotice: true,
    labels: {
      ...baseLabels,
      loginTitle: "MERIDIANCU STAFF LOGIN",
      userLabel: "User ID:",
      passwordLabel: "Passcode:",
      signOnButton: "Log In",
      navInquiry: "Member Lookup",
      navDrawer: "Cash Drawer",
      navSignOff: "Log Out",
      searchTitle: "MEMBER LOOKUP",
      memberNumberLabel: "Member #:",
      lastNameLabel: "Surname:",
      searchButton: "Look Up",
      resultsTitle: "LOOKUP RESULTS",
      colMemberNumber: "Member #",
      colName: "Member Name",
      colSsn: "Tax ID",
      detailTitle: "MEMBER PROFILE",
      detailMemberNumber: "Member #:",
      detailName: "Member Name:",
      detailSsn: "Tax ID:",
      newInquiryLink: "New Lookup",
      depositLabel: "Opening Deposit:",
      fromLabel: "Funding Account:",
      continueButton: "Next",
      noticeTitle: "IMPORTANT NOTICE",
      noticeText:
        "MeridianCU staff must review the daily compliance bulletin before accessing member records. " +
        "By continuing you confirm you have read today's bulletin.",
      noticeButton: "Acknowledge Notice",
    },
  },
};
