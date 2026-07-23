package com.yizhe.mxxy.offline;

import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import java.util.*;
import org.json.*;

public class MainActivity extends AppCompatActivity {
    private final List<Pet> pets = new ArrayList<>();
    private int gold = 10000;
    private Pet selectedPet, fusionA, fusionB, washTarget, skillTarget;
    private LinearLayout tabBar, logArea;
    private FrameLayout contentFrame;
    private TextView goldText;

    private static final int[] REAL_SHAPE_IDS = {4, 8, 15, 2131, 2139, 3014, 4058, 4068, 4085};
    private static final String[] SKILL_ICONS = {
        "skill_012beae50729","skill_18c4c8155e41","skill_37df6a2ea6b6","skill_3a492c083ffb",
        "skill_3a5414c42b82","skill_3b30da7cc61e","skill_3fd89a543536","skill_5175b20c27b7",
        "skill_588d130f809b","skill_5e83b8c76bab","skill_641025ea4583","skill_67f7b68af039",
        "skill_6929aa210954","skill_7ddb9c8b7397","skill_878d3b0b270f","skill_8ba3bbe247af",
        "skill_951f32e95753","skill_9ad7bc1f63b4","skill_9fbb7d284234","skill_9fcb7a8fd5e3",
        "skill_a95699c7bfd7","skill_bbdf434064e7","skill_bbfe5b6e0f6a","skill_c56c39557679",
        "skill_d8c55b631d29","skill_d93611a8a091","skill_dcd7bcf619e7","skill_ea396d6a3f84",
        "skill_fa9ce8fa77a8","skill_fb5fd9ff51ca"
    };

    static class Pet {
        String uid = UUID.randomUUID().toString().substring(0,8);
        int shapeId = 4, rarity = 0, level = 1;
        int life = 100, tzzz = 60, wgzz = 60, fgzz = 60, wfzz = 60, sdzz = 60, growUp = 100, gen = 0;
        List<String> skills = new ArrayList<>();

        int merit() { return (tzzz + wgzz + fgzz + wfzz + sdzz) / 5; }
        String rarityName() { return new String[]{"N","R","SR","SSR"}[rarity]; }
        int rarityColor() { return new int[]{0xFF888888,0xFF4488FF,0xFFAA44FF,0xFFFF4444}[rarity]; }
        int maxSkills() { return new int[]{2,3,4,6}[rarity]; }
        int hp() { return (int)(life * growUp / 100.0 * (0.9 + tzzz / 500.0)); }
        int atk() { return (int)(wgzz * growUp / 100.0 * (0.8 + merit() / 500.0)); }
    }

    private Pet randPet() {
        Pet p = new Pet();
        p.shapeId = REAL_SHAPE_IDS[(int)(Math.random() * REAL_SHAPE_IDS.length)];
        p.rarity = new int[]{0,0,0,0,0,1,1,1,2,2,3}[(int)(Math.random()*11)];
        p.life = 80 + (int)(Math.random()*81);
        p.tzzz = 40 + (int)(Math.random()*61);
        p.wgzz = 40 + (int)(Math.random()*61);
        p.fgzz = 40 + (int)(Math.random()*61);
        p.wfzz = 40 + (int)(Math.random()*61);
        p.sdzz = 40 + (int)(Math.random()*61);
        p.growUp = 70 + (int)(Math.random()*51);
        return p;
    }

    private void giveStarters() {
        pets.clear();
        for (int i = 0; i < 5; i++) {
            Pet p = randPet();
            if (i == 0 && p.rarity < 2) p.rarity = 2;
            pets.add(p);
        }
        pets.get(0).skills.add(SKILL_ICONS[0]); pets.get(0).skills.add(SKILL_ICONS[1]);
        pets.get(1).skills.add(SKILL_ICONS[2]);
        log("获得 5 只初始宠物");
        saveGame();
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        loadGame();
        if (pets.isEmpty()) giveStarters();
        buildUI();
    }

    private void buildUI() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF080818);

        // Header
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setPadding(16,16,16,16);
        header.setBackgroundColor(0xFF0d0d28);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("MXXY 离线版"); title.setTextColor(0xFFFFD700); title.setTextSize(18);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        header.addView(title);

        goldText = new TextView(this);
        goldText.setTextColor(0xFF888888); goldText.setTextSize(12);
        header.addView(goldText);
        root.addView(header);

        // Tab bar
        tabBar = new LinearLayout(this);
        tabBar.setOrientation(LinearLayout.HORIZONTAL);
        tabBar.setBackgroundColor(0xFF101028);
        String[][] tabs = {{"📦 仓库","inv"},{"🧬 合宠","fusion"},{"✨ 洗炼","wash"},{"📖 打书","skill"}};
        for (String[] t : tabs) {
            TextView tab = new TextView(this);
            tab.setText(t[0]); tab.setTextSize(12); tab.setTextColor(0xFF888888);
            tab.setPadding(16,12,16,12); tab.setTag(t[1]);
            tab.setOnClickListener(v -> switchTab((String)v.getTag()));
            tabBar.addView(tab);
        }
        root.addView(tabBar);

        // Content
        contentFrame = new FrameLayout(this);
        contentFrame.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(contentFrame);

        // Log
        logArea = new LinearLayout(this);
        logArea.setOrientation(LinearLayout.VERTICAL);
        logArea.setBackgroundColor(0xFF0a0a14);
        logArea.setPadding(8,8,8,8);
        logArea.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 160));
        root.addView(logArea);

        setContentView(root);
        switchTab("inv");
    }

    private void switchTab(String tab) {
        for (int i = 0; i < tabBar.getChildCount(); i++) {
            TextView t = (TextView) tabBar.getChildAt(i);
            boolean sel = tab.equals(t.getTag());
            t.setBackgroundColor(sel ? 0xFF1a1a3e : Color.TRANSPARENT);
            t.setTextColor(sel ? 0xFFFFD700 : 0xFF888888);
        }
        selectedPet = null;
        contentFrame.removeAllViews();
        switch (tab) {
            case "inv": contentFrame.addView(buildInventory()); break;
            case "fusion": contentFrame.addView(buildFusion()); break;
            case "wash": contentFrame.addView(buildWash()); break;
            case "skill": contentFrame.addView(buildSkill()); break;
        }
        goldText.setText("💰 " + gold);
    }

    private ScrollView buildInventory() {
        ScrollView sv = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(8,8,8,8);

        if (pets.isEmpty()) {
            TextView tv = new TextView(this);
            tv.setText("仓库为空"); tv.setTextSize(14); tv.setTextColor(0xFF888888);
            tv.setGravity(Gravity.CENTER); tv.setPadding(32,80,32,80);
            list.addView(tv);
            list.addView(btn("🎁 领取宠物", 0xFFFFD700, v -> { giveStarters(); switchTab("inv"); }));
        } else {
            for (Pet p : pets) list.addView(petCard(p, true));
        }
        sv.addView(list);
        return sv;
    }

    private LinearLayout petCard(Pet p, boolean actions) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundColor(0xFF101028);
        card.setPadding(12,12,12,12);
        GradientDrawable bd = new GradientDrawable();
        bd.setStroke(2, selectedPet != null && selectedPet.uid.equals(p.uid) ? 0xFFFFD700 : 0xFF2a2a4a);
        bd.setCornerRadius(12); bd.setColor(0xFF101028);
        card.setBackground(bd);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = 8;
        card.setLayoutParams(lp);
        card.setOnClickListener(v -> {
            selectedPet = p;
            if (fusionA == null) fusionA = p;
            else if (fusionB == null && !fusionA.uid.equals(p.uid)) fusionB = p;
            washTarget = p; skillTarget = p;
            switchTab("inv");
        });

        // Top row
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        TextView name = new TextView(this);
        name.setText("Shape #" + p.shapeId); name.setTextColor(0xFFFFD700); name.setTextSize(15);
        name.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        top.addView(name);

        TextView rare = new TextView(this);
        rare.setText(p.rarityName()); rare.setTextSize(10); rare.setTextColor(p.rarityColor());
        rare.setPadding(6,2,6,2);
        GradientDrawable rb = new GradientDrawable();
        rb.setStroke(1, p.rarityColor()); rb.setCornerRadius(4);
        rare.setBackground(rb);
        top.addView(rare);
        card.addView(top);

        TextView stats = new TextView(this);
        stats.setText("资质:" + p.merit() + " 成长:" + p.growUp + " HP:" + p.hp() + " 攻:" + p.atk() + " G" + p.gen);
        stats.setTextColor(0xFF888888); stats.setTextSize(10);
        card.addView(stats);

        TextView details = new TextView(this);
        details.setText("T" + p.tzzz + "/W" + p.wgzz + "/F" + p.fgzz + "/W" + p.wfzz + "/S" + p.sdzz);
        details.setTextColor(0xFF888888); details.setTextSize(10);
        card.addView(details);

        if (!p.skills.isEmpty()) {
            LinearLayout sr = new LinearLayout(this);
            sr.setOrientation(LinearLayout.HORIZONTAL);
            sr.setPadding(0,4,0,0);
            for (String sid : p.skills) {
                ImageView iv = new ImageView(this);
                int rid = getResources().getIdentifier(sid, "drawable", getPackageName());
                if (rid != 0) iv.setImageResource(rid);
                LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(28, 28);
                ilp.rightMargin = 4;
                iv.setLayoutParams(ilp);
                sr.addView(iv);
            }
            card.addView(sr);
        }

        if (actions) {
            LinearLayout act = new LinearLayout(this);
            act.setOrientation(LinearLayout.HORIZONTAL);
            act.setPadding(0,6,0,0);
            act.addView(btn("✨洗", 0xFFAA8800, 10, v -> { washTarget = p; wash(true); switchTab("wash"); }));
            act.addView(btn("🧬合", 0xFF4488FF, 10, v -> {
                if (fusionA == null || fusionA.uid.equals(p.uid)) fusionA = p; else fusionB = p;
                switchTab("fusion");
            }));
            card.addView(act);
        }
        return card;
    }

    private ScrollView buildFusion() {
        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(16,24,16,24);

        box.addView(label("选择两只宠物进行合宠", 0xFF888888, 12));
        box.addView(label("属性加权平均+扰动, 技能随机遗传", 0xFF888888, 10));

        LinearLayout slots = new LinearLayout(this);
        slots.setOrientation(LinearLayout.HORIZONTAL);
        slots.setGravity(Gravity.CENTER);
        slots.setPadding(0,16,0,16);
        slots.addView(petSlot(fusionA, () -> { fusionA = null; switchTab("fusion"); }));
        slots.addView(label(" + ", 0xFFFFD700, 20));
        slots.addView(petSlot(fusionB, () -> { fusionB = null; switchTab("fusion"); }));
        box.addView(slots);

        if (fusionA != null && fusionB != null) {
            Pet child = fusePreview();
            box.addView(label("= Shape #" + child.shapeId + " (" + child.rarityName() + ") G" + child.gen, 0xFFFFD700, 14));
            box.addView(label("💰 500金币", 0xFFFF8800, 12));
            box.addView(btn("开始合宠", 0xFFFF8800, v -> { doFusion(); switchTab("fusion"); }));
        } else {
            box.addView(label("↑ 点击仓库宠物添加到合宠栏 ↑", 0xFF555555, 12));
        }
        sv.addView(box);
        return sv;
    }

    private FrameLayout petSlot(Pet p, Runnable onClear) {
        FrameLayout fl = new FrameLayout(this);
        fl.setLayoutParams(new LinearLayout.LayoutParams(280, 200));
        if (p != null) {
            fl.addView(petCard(p, false));
            fl.setOnClickListener(v -> onClear.run());
        } else {
            TextView tv = new TextView(this);
            tv.setText("空"); tv.setTextColor(0xFF555555); tv.setGravity(Gravity.CENTER);
            fl.addView(tv);
        }
        return fl;
    }

    private ScrollView buildWash() {
        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(16,24,16,24);

        box.addView(label("重新随机5项资质+成长值, 30%提升概率", 0xFF888888, 12));
        if (washTarget != null) {
            box.addView(petCard(washTarget, false));
            int cost = new int[]{100,200,500,1000}[washTarget.rarity];
            box.addView(label("💰 " + cost + "金币/次", 0xFFFF8800, 12));
            box.addView(btn("✨ 洗炼×1", 0xFFFFD700, v -> { wash(true); switchTab("wash"); }));
            box.addView(btn("✨ 连洗×5", 0xFFAA44FF, v -> { for(int i=0;i<5;i++) wash(false); switchTab("wash"); }));
        } else {
            box.addView(label("↑ 在仓库中点击宠物 ↑", 0xFF555555, 12));
        }
        sv.addView(box);
        return sv;
    }

    private ScrollView buildSkill() {
        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(16,24,16,24);

        box.addView(label("从30个真实解码技能图标学习, 满时随机替换", 0xFF888888, 12));
        if (skillTarget != null) {
            box.addView(petCard(skillTarget, false));
            box.addView(label("💰 300金币 | " + skillTarget.skills.size() + "/" + skillTarget.maxSkills() + "槽", 0xFFFF8800, 12));

            GridLayout grid = new GridLayout(this);
            grid.setColumnCount(5);
            for (String sid : SKILL_ICONS) {
                if (skillTarget.skills.contains(sid)) continue;
                ImageView iv = new ImageView(this);
                int rid = getResources().getIdentifier(sid, "drawable", getPackageName());
                if (rid != 0) iv.setImageResource(rid);
                GridLayout.LayoutParams glp = new GridLayout.LayoutParams();
                glp.width = 72; glp.height = 72; glp.setMargins(6,6,6,6);
                iv.setLayoutParams(glp);
                String sidF = sid;
                iv.setOnClickListener(v -> { teachSkill(sidF); switchTab("skill"); });
                grid.addView(iv);
            }
            box.addView(grid);
        } else {
            box.addView(label("↑ 在仓库中点击宠物 ↑", 0xFF555555, 12));
        }
        sv.addView(box);
        return sv;
    }

    // Helpers
    private TextView btn(String label, int color, View.OnClickListener onClick) {
        return btn(label, color, 12, onClick);
    }
    private TextView btn(String label, int color, float size, View.OnClickListener onClick) {
        TextView tv = new TextView(this);
        tv.setText(label); tv.setTextColor(color); tv.setTextSize(size);
        tv.setPadding(12,8,12,8);
        GradientDrawable bg = new GradientDrawable();
        bg.setStroke(1, color); bg.setCornerRadius(8); bg.setColor(0xFF1a1a3e);
        tv.setBackground(bg);
        tv.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(4,4,4,4);
        tv.setLayoutParams(lp);
        return tv;
    }
    private TextView label(String t, int c, float s) {
        TextView tv = new TextView(this);
        tv.setText(t); tv.setTextColor(c); tv.setTextSize(s);
        tv.setGravity(Gravity.CENTER);
        return tv;
    }

    // Game logic
    private Pet fusePreview() {
        Pet a = fusionA, b = fusionB;
        Pet c = new Pet();
        c.shapeId = Math.random() < 0.5 ? a.shapeId : b.shapeId;
        c.rarity = new int[]{0,0,1,1,1, a.rarity>=2||b.rarity>=2?2:1, a.rarity>=2&&b.rarity>=2?3:1}[(int)(Math.random()*7)];
        c.gen = Math.max(a.gen, b.gen) + 1;
        c.life = (int)((a.life+b.life)/2*(0.85+Math.random()*0.3));
        c.tzzz = (int)((a.tzzz+b.tzzz)/2*(0.85+Math.random()*0.3));
        c.wgzz = (int)((a.wgzz+b.wgzz)/2*(0.85+Math.random()*0.3));
        c.fgzz = (int)((a.fgzz+b.fgzz)/2*(0.85+Math.random()*0.3));
        c.wfzz = (int)((a.wfzz+b.wfzz)/2*(0.85+Math.random()*0.3));
        c.sdzz = (int)((a.sdzz+b.sdzz)/2*(0.85+Math.random()*0.3));
        c.growUp = (int)((a.growUp+b.growUp)/2*(0.85+Math.random()*0.3));
        Set<String> all = new LinkedHashSet<>(); all.addAll(a.skills); all.addAll(b.skills);
        List<String> shuffled = new ArrayList<>(all); Collections.shuffle(shuffled);
        c.skills.addAll(shuffled.subList(0, Math.min(shuffled.size(), c.maxSkills())));
        return c;
    }

    private void doFusion() {
        if (fusionA == null || fusionB == null || gold < 500) { log("金币不足!"); return; }
        gold -= 500;
        Pet c = fusePreview();
        pets.removeIf(p -> p.uid.equals(fusionA.uid) || p.uid.equals(fusionB.uid));
        pets.add(c);
        log("合宠: #" + fusionA.shapeId + " + #" + fusionB.shapeId + " = #" + c.shapeId + "(" + c.rarityName() + ") G" + c.gen);
        fusionA = null; fusionB = null; selectedPet = c;
        saveGame();
    }

    private void wash(boolean logResult) {
        Pet p = washTarget; if (p == null) return;
        int cost = new int[]{100,200,500,1000}[p.rarity];
        if (gold < cost) { log("金币不足!"); return; }
        gold -= cost;
        int oldM = p.merit();
        boolean up = Math.random() < 0.3;
        p.tzzz = up ? Math.min(100, p.tzzz + (int)(Math.random()*8+1)) : 40 + (int)(Math.random()*61);
        p.wgzz = up ? Math.min(100, p.wgzz + (int)(Math.random()*8+1)) : 40 + (int)(Math.random()*61);
        p.fgzz = up ? Math.min(100, p.fgzz + (int)(Math.random()*8+1)) : 40 + (int)(Math.random()*61);
        p.wfzz = up ? Math.min(100, p.wfzz + (int)(Math.random()*8+1)) : 40 + (int)(Math.random()*61);
        p.sdzz = up ? Math.min(100, p.sdzz + (int)(Math.random()*8+1)) : 40 + (int)(Math.random()*61);
        p.growUp = up ? Math.min(150, p.growUp + (int)(Math.random()*5+1)) : 70 + (int)(Math.random()*51);
        if (logResult) log("洗炼 #" + p.shapeId + ": 资质" + (p.merit() >= oldM ? "+" : "") + (p.merit() - oldM) + (up ? " ✨提升!" : ""));
        saveGame();
    }

    private void teachSkill(String sid) {
        Pet p = skillTarget; if (p == null) return;
        if (gold < 300) { log("金币不足!"); return; }
        if (p.skills.contains(sid)) { log("已有此技能!"); return; }
        gold -= 300;
        if (p.skills.size() >= p.maxSkills()) p.skills.remove((int)(Math.random() * p.skills.size()));
        p.skills.add(sid);
        log("打书 #" + p.shapeId + ": 学会新技能");
        saveGame();
    }

    private void log(String msg) {
        TextView tv = new TextView(this);
        tv.setText(msg); tv.setTextColor(0xFF888888); tv.setTextSize(10);
        logArea.addView(tv, 0);
        if (logArea.getChildCount() > 50) logArea.removeViewAt(logArea.getChildCount() - 1);
    }

    private void saveGame() {
        try {
            JSONArray arr = new JSONArray();
            for (Pet p : pets) {
                JSONObject o = new JSONObject();
                o.put("uid",p.uid); o.put("shapeId",p.shapeId); o.put("rarity",p.rarity);
                o.put("level",p.level); o.put("life",p.life);
                o.put("tzzz",p.tzzz); o.put("wgzz",p.wgzz); o.put("fgzz",p.fgzz);
                o.put("wfzz",p.wfzz); o.put("sdzz",p.sdzz); o.put("growUp",p.growUp);
                o.put("gen",p.gen); o.put("skills",new JSONArray(p.skills));
                arr.put(o);
            }
            JSONObject save = new JSONObject();
            save.put("gold", gold); save.put("pets", arr);
            getSharedPreferences("mxxy", MODE_PRIVATE).edit().putString("save", save.toString()).apply();
        } catch (Exception e) { log("存档失败: " + e.getMessage()); }
    }

    private void loadGame() {
        String s = getSharedPreferences("mxxy", MODE_PRIVATE).getString("save", null);
        if (s == null) return;
        try {
            JSONObject save = new JSONObject(s);
            gold = save.getInt("gold");
            JSONArray arr = save.getJSONArray("pets");
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Pet p = new Pet();
                p.uid = o.getString("uid"); p.shapeId = o.getInt("shapeId");
                p.rarity = o.getInt("rarity"); p.level = o.getInt("level");
                p.life = o.getInt("life");
                p.tzzz = o.getInt("tzzz"); p.wgzz = o.getInt("wgzz"); p.fgzz = o.getInt("fgzz");
                p.wfzz = o.getInt("wfzz"); p.sdzz = o.getInt("sdzz"); p.growUp = o.getInt("growUp");
                p.gen = o.getInt("gen");
                JSONArray sk = o.getJSONArray("skills");
                for (int j = 0; j < sk.length(); j++) p.skills.add(sk.getString(j));
                pets.add(p);
            }
            log("读取存档: " + pets.size() + "只宠物");
        } catch (Exception e) { log("存档损坏"); }
    }
}
