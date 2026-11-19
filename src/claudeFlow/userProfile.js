/**
 * 讀取 Claude Flow 的使用者資料 users/{uid}（角色、是否停用）。
 *
 * 文件由 Claude Flow 建立與維護（登入時建檔、管理員調整角色與停用），台股只讀不寫。
 * 對應 Claude Flow 的 src/services/users.ts 的 subscribeUserProfile，只取台股用得到的欄位。
 */
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebaseApp.js';

/** @typedef {{ uid: string, role: 'admin'|'user', disabled: boolean }} ClaudeFlowProfile */

/**
 * 文件資料 → 台股需要的欄位；缺欄位或型別不對時給安全預設值。
 * disabled 缺欄位視為未停用，與 Claude Flow 的 toUserProfile 一致
 * （真正的存取控制在 Firestore 規則與 API 驗證，那兩處缺欄位都視為停用）。
 * @returns {ClaudeFlowProfile}
 */
export function toProfile(id, data) {
  const d = data ?? {};
  return {
    uid: typeof d.uid === 'string' ? d.uid : id,
    role: d.role === 'admin' ? 'admin' : 'user',
    disabled: d.disabled === true,
  };
}

/**
 * @param {string} uid
 * @param {(profile: ClaudeFlowProfile|null) => void} onData 文件不存在時為 null
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} 退訂
 */
export function subscribeUserProfile(uid, onData, onError) {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => onData(snap.exists() ? toProfile(snap.id, snap.data()) : null),
    (err) => onError?.(err instanceof Error ? err : new Error(String(err))),
  );
}
