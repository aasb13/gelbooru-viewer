import QtQuick
import qs.Common
import qs.Services
import qs.Modules.Plugins

PluginComponent {
    id: root

    readonly property var posts: pluginData.posts ?? []
    readonly property string query: pluginData.query ?? ""
    readonly property int page: pluginData.page ?? 0
    readonly property int totalPages: pluginData.totalPages ?? 0
    readonly property bool loading: pluginData.loading ?? false
    readonly property int fetchTick: pluginData.fetchTick ?? 0
    readonly property string ratingFilter: pluginData.ratingFilter ?? "general"
    readonly property int refreshInterval: pluginData.refreshInterval ?? 10
    readonly property int gridColumns: pluginData.gridColumns ?? 3
    readonly property bool viewerOpen: pluginData.viewerOpen ?? false

    readonly property var ratingRanks: ({
        "general": 0,
        "sensitive": 1,
        "questionable": 2,
        "explicit": 3
    })

    property int requestSeq: 0

    onQueryChanged: fetchPosts()
    onFetchTickChanged: {
        if (fetchTick > 0)
            fetchPosts()
    }
    onRatingFilterChanged: fetchPosts()

    Component.onCompleted: fetchPosts()

    Timer {
        interval: root.refreshInterval * 60 * 1000
        running: root.viewerOpen && root.refreshInterval > 0
        repeat: true
        onTriggered: root.fetchPosts()
        onIntervalChanged: restart()
    }

    GelbooruWindow {
        id: viewer

        visible: root.viewerOpen

        posts: root.posts
        query: root.query
        page: root.page
        totalPages: root.totalPages
        loading: root.loading
        fetchTick: root.fetchTick
        columns: root.gridColumns
        mutate: (key, value) => pluginService?.savePluginData(pluginId, key, value)

        onVisibleChanged: {
            if (!visible && (pluginData.viewerOpen ?? false))
                pluginService?.savePluginData(pluginId, "viewerOpen", false)
        }
    }

    // The dapi caps limit at 100 posts per request (documented limit).
    function fetchPosts() {
        const userTags = (query || (pluginData.tags ?? "")).trim()
        const tagList = userTags.length > 0 ? userTags.split(/\s+/) : []
        if (ratingFilter.length > 0)
            tagList.push("rating:" + ratingFilter)
        const tagsParam = tagList.map(tag => encodeURIComponent(tag)).join("+")
        const url = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&pid=" + page
            + (tagsParam.length > 0 ? "&tags=" + tagsParam : "")

        pluginService?.savePluginData(pluginId, "loading", true)
        const seq = ++requestSeq
        const request = new XMLHttpRequest()
        request.open("GET", url)
        request.onreadystatechange = () => {
            if (request.readyState !== 4)
                return
            if (seq !== requestSeq)
                return
            if (request.status !== 200) {
                pluginService?.savePluginData(pluginId, "loading", false)
                ToastService.showError("Gelbooru", "Could not load posts — check your connection.")
                return
            }

            let parsed
            try {
                parsed = JSON.parse(request.responseText)
            } catch (error) {
                pluginService?.savePluginData(pluginId, "loading", false)
                ToastService.showError("Gelbooru", "Received a malformed response.")
                return
            }

            const maxRank = ratingRanks[ratingFilter] ?? 0
            const raw = parsed.post ?? []
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
            const slim = []
            for (let i = 0; i < list.length; i++) {
                const post = list[i]
                const rank = ratingRanks[post.rating ?? ""]
                if (rank === undefined || rank > maxRank)
                    continue
                slim.push({
                    id: post.id ?? 0,
                    previewUrl: post.preview_url ?? "",
                    fileUrl: post.file_url ?? "",
                    width: post.width ?? 0,
                    height: post.height ?? 0,
                    score: post.score ?? 0,
                    rating: post.rating ?? "",
                    tags: post.tags ?? ""
                })
            }

            const attrs = parsed["@attributes"] ?? {}
            const count = attrs.count ?? 0
            pluginService?.savePluginData(pluginId, "posts", slim)
            pluginService?.savePluginData(pluginId, "totalPages", count > 0
                ? Math.ceil(count / 100)
                : (slim.length >= 100 ? page + 2 : page + 1))
            pluginService?.savePluginData(pluginId, "loading", false)
        }
        request.send()
    }
}
