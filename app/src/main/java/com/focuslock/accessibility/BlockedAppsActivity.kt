package com.focuslock.accessibility

import android.content.Intent
import android.content.SharedPreferences
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * Lets the user control every app before protection starts:
 *  - Block: the app can never come to foreground.
 *  - Skip scan: search-word checking is off inside this app.
 * Unchecked apps get search-word checking (the default).
 * X is blocked by default.
 */
class BlockedAppsActivity : AppCompatActivity() {

    data class AppEntry(val label: String, val pkg: String, val icon: Drawable?)

    private lateinit var adapter: AppAdapter
    private val allApps = mutableListOf<AppEntry>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_blocked_apps)

        val recycler = findViewById<RecyclerView>(R.id.appsRecycler)
        recycler.layoutManager = LinearLayoutManager(this)
        adapter = AppAdapter()
        recycler.adapter = adapter

        findViewById<EditText>(R.id.appsSearch).addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {
                adapter.filter(s?.toString() ?: "")
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        Thread { loadApps() }.start()
    }

    private fun prefs(): SharedPreferences =
        getSharedPreferences("focuslock_prefs", MODE_PRIVATE)

    private fun loadApps() {
        val pm = packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val list = pm.queryIntentActivities(main, 0)
            .filter { it.activityInfo.packageName != packageName }
            .mapNotNull { ri ->
                try {
                    AppEntry(
                        ri.loadLabel(pm).toString(),
                        ri.activityInfo.packageName,
                        ri.loadIcon(pm)
                    )
                } catch (t: Throwable) {
                    null
                }
            }
            .sortedBy { it.label.lowercase() }
        runOnUiThread {
            allApps.clear()
            allApps.addAll(list)
            adapter.setData(list)
        }
    }

    private fun isBlocked(pkg: String): Boolean =
        prefs().getStringSet("blocked_apps", setOf("com.twitter.android"))?.contains(pkg) == true

    private fun isSkipped(pkg: String): Boolean =
        prefs().getStringSet("skip_apps", emptySet())?.contains(pkg) == true

    private fun setBlocked(pkg: String, on: Boolean) {
        val set = HashSet(prefs().getStringSet("blocked_apps", setOf("com.twitter.android")) ?: emptySet())
        if (on) set.add(pkg) else set.remove(pkg)
        prefs().edit().putStringSet("blocked_apps", set).apply()
    }

    private fun setSkipped(pkg: String, on: Boolean) {
        val set = HashSet(prefs().getStringSet("skip_apps", emptySet()) ?: emptySet())
        if (on) set.add(pkg) else set.remove(pkg)
        prefs().edit().putStringSet("skip_apps", set).apply()
    }

    class AppViewHolder(v: View) : RecyclerView.ViewHolder(v) {
        val icon: ImageView = v.findViewById(R.id.appIcon)
        val name: TextView = v.findViewById(R.id.appName)
        val pkg: TextView = v.findViewById(R.id.appPkg)
        val block: CheckBox = v.findViewById(R.id.checkBlock)
        val skip: CheckBox = v.findViewById(R.id.checkSkip)
    }

    inner class AppAdapter : RecyclerView.Adapter<AppViewHolder>() {

        private var shown: List<AppEntry> = emptyList()

        fun setData(list: List<AppEntry>) {
            shown = list
            notifyDataSetChanged()
        }

        fun filter(q: String) {
            val query = q.trim().lowercase()
            shown = if (query.isEmpty()) allApps
            else allApps.filter {
                it.label.lowercase().contains(query) || it.pkg.lowercase().contains(query)
            }
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): AppViewHolder {
            val v = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_blocked_app, parent, false)
            return AppViewHolder(v)
        }

        override fun getItemCount(): Int = shown.size

        override fun onBindViewHolder(h: AppViewHolder, position: Int) {
            val app = shown[position]
            h.icon.setImageDrawable(app.icon)
            h.name.text = app.label
            h.pkg.text = app.pkg
            h.block.setOnCheckedChangeListener(null)
            h.skip.setOnCheckedChangeListener(null)
            h.block.isChecked = isBlocked(app.pkg)
            h.skip.isChecked = isSkipped(app.pkg)
            h.skip.isEnabled = !h.block.isChecked
            h.block.setOnCheckedChangeListener { _, on ->
                setBlocked(app.pkg, on)
                h.skip.isEnabled = !on
            }
            h.skip.setOnCheckedChangeListener { _, on ->
                setSkipped(app.pkg, on)
            }
        }
    }
}
